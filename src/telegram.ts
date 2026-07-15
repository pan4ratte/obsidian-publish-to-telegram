// telegram.ts
// Account (User API) send path — runs on mtcute (github.com/mtcute/mtcute). This is the
// path a preset uses for the "account" and "account-rich" methods; bot methods go through
// telegram-bot.ts (Bot API) instead.
import { App, TFile, requestUrl } from "obsidian";
import {
    TelegramClient,
    WebCryptoProvider,
    WebSocketTransport,
    MemoryStorage,
    InputMedia,
    type InputText,
    type InputMediaLike,
    type Message,
} from "@mtcute/web";
import { thtml } from "@mtcute/html-parser";
import wasmBytes from "@mtcute/wasm/mtcute.wasm";
import { TelegramChannel, TelegramSettings, TelegramSecrets, PendingScheduledLink } from "./types";
import { errMessage } from "./util";
import { mdToTelegramHtml, obsidianToRichMarkdown } from "./markdown";

// ─── Internal result & media types ────────────────────────────────────────────

interface SendResult {
    link: string;
    messageId: number;
    commentLinks?: string[];
    scheduled?: ScheduledSendInfo;
}

// Captured at scheduling time so the published post can later be matched back to
// this note. `scheduledDate` (== published message .date) and `text` (plain body)
// are the correlation keys; `scheduledMsgId` lets us check the scheduled queue.
export interface ScheduledSendInfo {
    chatId: string;
    topicId?: number;
    scheduledMsgId: number;
    scheduledDate: number;
    text: string;
}

interface MediaFile {
    name: string;
    extension: string;
    isLocal: boolean;   // true for vault files, false for remote HTTP(S) media
    getBlob: () => Promise<Blob>;
}

// ─── Media type helpers ───────────────────────────────────────────────────────

const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "mkv", "webm"]);

// ─── Frontmatter extraction ───────────────────────────────────────────────────

function extractFrontmatter(content: string): { frontmatter: string; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const body = match ? content.slice(match[0].length) : content;
    if (!match) return { frontmatter: "", body };
    return { frontmatter: match[1], body };
}

// ─── Split helpers ────────────────────────────────────────────────────────────

function splitBodyByMarkers(body: string): string[] {
    const marker = /^[ \t]*(?:%%\s*\\split\s*%%|<!--\s*\\split\s*-->)[ \t]*$/gm;
    return body.split(marker).map(p => p.trim()).filter(p => p.length > 0);
}

// ─── Attachment collection (shared) ───────────────────────────────────────────

const SUPPORTED_MEDIA_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "pdf", ...VIDEO_EXTS]);

function collectMediaFiles(app: App, body: string, sourceFile: TFile): { attachments: MediaFile[]; mdEmbeds: TFile[] } {
    const wikilinkRegex = /!\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;
    const mdLinkRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
    const reverseMdLinkRegex = /!\(([^)]+)\)\[[^\]]*\]/g;

    const seen = new Set<string>();
    const attachments: MediaFile[] = [];
    const mdEmbeds: TFile[] = [];

    const processLinkpath = (rawPath: string) => {
        let cleanPath = rawPath.split(/\s+"/)[0].split(/[?#]/)[0].trim();

        if (/^https?:\/\//i.test(cleanPath)) {
            if (!seen.has(cleanPath)) {
                seen.add(cleanPath);
                const ext = cleanPath.split('.').pop()?.toLowerCase() || "";
                if (SUPPORTED_MEDIA_EXTS.has(ext)) {
                    attachments.push({
                        name: cleanPath.split('/').pop() || `media.${ext}`,
                        extension: ext,
                        isLocal: false,
                        getBlob: async () => {
                            const response = await requestUrl({ url: cleanPath });
                            return new Blob([response.arrayBuffer]);
                        }
                    });
                }
            }
            return;
        }

        try { cleanPath = decodeURIComponent(cleanPath); } catch { /* keep raw path if not URI-encoded */ }

        const resolved = app.metadataCache.getFirstLinkpathDest(cleanPath, sourceFile.path);
        if (resolved instanceof TFile && !seen.has(resolved.path)) {
            seen.add(resolved.path);
            if (SUPPORTED_MEDIA_EXTS.has(resolved.extension)) {
                attachments.push({
                    name: resolved.name,
                    extension: resolved.extension,
                    isLocal: true,
                    getBlob: async () => new Blob([await app.vault.readBinary(resolved)])
                });
            } else if (resolved.extension === "md") {
                mdEmbeds.push(resolved);
            }
        }
    };

    let m: RegExpExecArray | null;
    while ((m = wikilinkRegex.exec(body)) !== null) processLinkpath(m[1]);
    while ((m = mdLinkRegex.exec(body)) !== null) processLinkpath(m[1]);
    while ((m = reverseMdLinkRegex.exec(body)) !== null) processLinkpath(m[1]);

    return { attachments, mdEmbeds };
}

// Wraps an embedded .md TFile as a document MediaFile, so it can be uploaded as a
// file attachment when md embeds are not being sent as comments.
function mdEmbedToMedia(app: App, file: TFile): MediaFile {
    return {
        name: file.name,
        extension: file.extension,
        isLocal: true,
        getBlob: async () => new Blob([await app.vault.readBinary(file)]),
    };
}

// ─── Post link helpers ────────────────────────────────────────────────────────

function buildPostLinkFromChatId(chatId: string, messageId: number, topicId?: number): string {
    const withTopic = topicId && topicId !== 1;
    if (chatId.startsWith("@")) {
        if (withTopic) return `https://t.me/${chatId.slice(1)}/${topicId}/${messageId}`;
        return `https://t.me/${chatId.slice(1)}/${messageId}`;
    }
    const channelId = chatId.replace(/^-100/, "");
    if (withTopic) return `https://t.me/c/${channelId}/${topicId}/${messageId}`;
    return `https://t.me/c/${channelId}/${messageId}`;
}

export function parseLinkComponents(link: string): { chatId: string; messageId: number } | null {
    const privateMatch = link.match(/t\.me\/c\/(\d+)\/(\d+)\/?$/);
    if (privateMatch) return { chatId: `-100${privateMatch[1]}`, messageId: parseInt(privateMatch[2], 10) };
    const publicMatch = link.match(/t\.me\/([^/]+)\/(\d+)\/?$/);
    if (publicMatch) return { chatId: `@${publicMatch[1]}`, messageId: parseInt(publicMatch[2], 10) };
    return null;
}

function resolveChatId(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith("@") || /^-?\d+$/.test(trimmed)) return trimmed;
    return `@${trimmed}`;
}

// mtcute InputPeerLike: a marked numeric id (channels -100…, chats -…, users +…) is
// passed as a number; a "@username" (or bare username) is passed as a string.
function peerFor(chatId: string): string | number {
    return /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;
}

// Bridges the plugin's Telegram-HTML (from mdToTelegramHtml) to mtcute's InputText.
// `thtml` (whitespace-preserving variant) keeps our real newlines instead of collapsing
// them like the default `html` parser; the tags we emit (b/i/u/s/code/pre/blockquote/
// a/spoiler) are all recognised by @mtcute/html-parser.
function htmlText(html: string): InputText {
    return thtml(html);
}

// Wraps a MediaFile's bytes in a File so uploads keep the original filename (matters for
// documents), then builds the right InputMedia for the extension. `asDocument` forces the
// document type (PDFs, embedded .md). `caption` rides on the first item of an album only.
async function toInputMedia(file: MediaFile, asDocument: boolean, caption?: InputText): Promise<InputMediaLike> {
    const blob = await file.getBlob();
    const upload = new File([blob], file.name);
    const ext = file.extension.toLowerCase();
    if (asDocument) return InputMedia.document(upload, { fileName: file.name, caption });
    if (VIDEO_EXTS.has(ext)) return InputMedia.video(upload, { fileName: file.name, caption });
    if (ext === "gif") return InputMedia.animation(upload, { fileName: file.name, caption });
    if (["jpg", "jpeg", "png", "webp"].includes(ext)) return InputMedia.photo(upload, { caption });
    return InputMedia.document(upload, { fileName: file.name, caption });
}

// ─── Account (mtcute) client ──────────────────────────────────────────────────

// Telegram Desktop api credentials (public, used as fallback with an existing session).
export const DEFAULT_TG_API_ID = 2040;
export const DEFAULT_TG_API_HASH = "b18441a1ff607e10a989891a5462e627";

// Credentials used for new session creation (QR and phone auth).
// Register your own app at https://my.telegram.org → API Development Tools.
export const AUTH_API_ID = 2040;
export const AUTH_API_HASH = "b18441a1ff607e10a989891a5462e627";

// mtcute's crypto uses a wasm module for AES-IGE (WebCrypto has no IGE). The bytes are
// embedded at build time; compile once, asynchronously — Chromium (Obsidian's renderer)
// forbids the synchronous `new WebAssembly.Module()` for modules >4KB on the main thread.
let wasmModulePromise: Promise<WebAssembly.Module> | null = null;
function getWasmModule(): Promise<WebAssembly.Module> {
    if (!wasmModulePromise) wasmModulePromise = WebAssembly.compile(wasmBytes);
    return wasmModulePromise;
}

// Builds a client (does not connect). `session` is an mtcute string session; omit it for
// the login flow. Request-only: updates are disabled (no update loop / keepalive pings).
export async function buildClient(session?: string, apiId?: number, apiHash?: string): Promise<TelegramClient> {
    const client = new TelegramClient({
        apiId: apiId || DEFAULT_TG_API_ID,
        apiHash: apiHash || DEFAULT_TG_API_HASH,
        storage: new MemoryStorage(),
        crypto: new WebCryptoProvider({ wasmInput: await getWasmModule() }),
        transport: new WebSocketTransport(),
        disableUpdates: true,
    });
    if (session) await client.importSession(session);
    return client;
}

export async function createClient(session: string, apiId?: number, apiHash?: string): Promise<TelegramClient> {
    const client = await buildClient(session, apiId, apiHash);
    await client.connect();
    return client;
}

export async function checkIsForum(client: TelegramClient, entity: string | number): Promise<boolean> {
    try {
        const chat = await client.getChat(entity);
        return chat.isForum;
    } catch {
        return false;
    }
}

// ─── Dialog listing ───────────────────────────────────────────────────────────

export interface DialogData {
    id: string;       // "@username" for public, "-100XXXX" for channels, numeric string for others
    title: string;
    topicId?: number; // set for forum topics; 1 = General (also set on the parent group entry)
}

export async function getUserDialogs(client: TelegramClient): Promise<DialogData[]> {
    try {
        const results: DialogData[] = [];
        for await (const dialog of client.iterDialogs({ limit: 300, folder: 0 })) {
            const peer = dialog.peer;
            if (!peer) continue;

            const raw = peer.raw;
            const channel = raw._ === "channel" ? raw : null;
            const chat = raw._ === "chat" ? raw : null;
            const username = peer.username ?? undefined;

            // Skip entities where the user cannot post messages
            if (channel) {
                if (channel.broadcast) {
                    // Broadcast channel: only creators/admins with postMessages right can post
                    if (!channel.creator && !channel.adminRights?.postMessages) continue;
                } else {
                    // Supergroup: skip if non-admins are banned from sending messages
                    if (!channel.creator && !channel.adminRights && channel.defaultBannedRights?.sendMessages) continue;
                }
            }

            let id: string;
            if (username) {
                id = `@${username}`;
            } else if (channel) {
                id = `-100${channel.id.toString()}`;
            } else if (chat) {
                id = `-${chat.id.toString()}`;
            } else {
                id = peer.id.toString();
            }
            if (!id) continue;
            const title = username ? `${peer.displayName} (@${username})` : peer.displayName;

            const isForum = peer.type === "chat" ? peer.isForum : false;
            results.push({ id, title, topicId: isForum ? 1 : undefined });

            // Fetch topics for forum supergroups and append them as individual entries
            if (isForum) {
                try {
                    const topics = await client.getForumTopics(peer.id);
                    for (const topic of topics) {
                        if (topic.id === 1) continue; // skip General — covered by the group entry
                        results.push({ id, title: `${title}: ${topic.title}`, topicId: topic.id });
                    }
                } catch {
                    // topic fetch failed — group entry without topics is still usable
                }
            }
        }
        return results;
    } catch {
        return [];
    }
}

// ─── Comment (discussion) sending ─────────────────────────────────────────────

async function sendCommentViaAccount(
    client: TelegramClient,
    channelChatId: string,
    channelMessageId: number,
    text: string,
    richMarkdown: string,
    silent: boolean,
): Promise<string | null> {
    const channelPeer = peerFor(channelChatId);

    // Sends the comment as a Rich Message when rich markdown is provided ("account-rich"),
    // else as a classic HTML message. Both accept the same commentTo/replyTo/sendAs params.
    const sendComment = (params: { commentTo?: number; replyTo?: number; sendAs?: string | number; silent: boolean }): Promise<Message> =>
        richMarkdown.length > 0
            ? client.sendRichMessage(channelPeer, { content: { type: "markdown", content: richMarkdown }, ...params })
            : client.sendText(channelPeer, htmlText(text), params);

    // Resolve the discussion group (if any) and the sendAs identity. Rule: private channels
    // (no public username) post the comment as the user's own account; public channels post
    // as the channel itself. mtcute resolves the sendAs InputPeer (and its access hash) from
    // "me" / the channel id, so no manual GetSendAs is needed.
    let linkedGroupChatId: string | undefined;
    let sendAs: string | number | undefined;
    try {
        const full = await client.getFullChat(channelPeer);
        if (full.linkedChat) linkedGroupChatId = full.linkedChat.id.toString();
        const isPrivate = !full.username;
        sendAs = isPrivate ? "me" : channelPeer;
    } catch { /* not a channel or no access — fall through to a direct reply */ }

    if (linkedGroupChatId) {
        // Post into the linked discussion group as a comment on the channel post. The
        // forwarded thread head may not exist immediately, so retry the discovery a few times.
        const MAX_ATTEMPTS = 5;
        const DELAY_MS = 1500;
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            if (attempt > 0) await new Promise(r => window.setTimeout(r, DELAY_MS));
            try {
                const sent = await sendComment({ commentTo: channelMessageId, sendAs, silent });
                return buildPostLinkFromChatId(linkedGroupChatId, sent.id);
            } catch (err) {
                // A not-yet-forwarded post is expected early on — retry. Anything else, stop.
                const msg = errMessage(err).toUpperCase();
                if (attempt < MAX_ATTEMPTS - 1 && (msg.includes("MSG_ID_INVALID") || msg.includes("NOT_FOUND"))) continue;
                throw err;
            }
        }
        return null;
    }

    // No discussion group: reply directly in the channel
    const sent = await sendComment({ replyTo: channelMessageId, silent });
    return buildPostLinkFromChatId(channelChatId, sent.id);
}

// ─── Part sending ─────────────────────────────────────────────────────────────

async function sendPartViaAccount(
    app: App,
    body: string,
    channel: TelegramChannel,
    client: TelegramClient,
    silent: boolean,
    attachUnderText: boolean,
    sourceFile: TFile,
    treatMdEmbedsAsComments: boolean,
    postAsRich: boolean,
    scheduleDate?: Date,
    onProgress?: () => void,
): Promise<SendResult | null> {
    const text = mdToTelegramHtml(body);
    const richMarkdown = postAsRich ? obsidianToRichMarkdown(body) : "";
    const { attachments, mdEmbeds } = collectMediaFiles(app, body, sourceFile);

    const peer = peerFor(channel.chatId);
    const topicId = channel.topicId;
    const threadId = topicId ? topicId : undefined;

    const photoAndVideoFiles = attachments.filter(f =>
        ["jpg", "jpeg", "png", "webp"].includes(f.extension) || VIDEO_EXTS.has(f.extension)
    );
    const gifFiles = attachments.filter(f => f.extension === "gif");
    // PDFs always upload as documents; embedded .md files join them as document
    // attachments unless they're being sent as comments instead.
    const pdfFiles = attachments.filter(f => f.extension === "pdf");
    const mdDocFiles = treatMdEmbedsAsComments ? [] : mdEmbeds.map(f => mdEmbedToMedia(app, f));
    const docFiles = [...pdfFiles, ...mdDocFiles];

    let result: SendResult | null = null;
    let captionConsumed = false;
    let firstMsg: Message | undefined;

    // Sends one media batch (single → sendMedia, multiple → sendMediaGroup). The caption
    // (as HTML) rides on the first item; attachUnderText renders it above the media.
    const sendBatch = async (files: MediaFile[], asDocument: boolean, caption: string): Promise<Message> => {
        const invert = caption.length > 0 && attachUnderText;
        if (files.length === 1) {
            const media = await toInputMedia(files[0], asDocument, caption.length ? htmlText(caption) : undefined);
            return client.sendMedia(peer, media, { invert, silent, schedule: scheduleDate, threadId });
        }
        const medias = await Promise.all(files.map((f, i) =>
            toInputMedia(f, asDocument, i === 0 && caption.length ? htmlText(caption) : undefined)));
        const msgs = await client.sendMediaGroup(peer, medias, { invertMedia: invert, silent, schedule: scheduleDate, threadId });
        return msgs[0];
    };

    // ── Rich post with no local media: send as a Rich Message ─────────────────
    // Rich Messages can only reference web media (embedded in the markdown); local uploads
    // aren't supported. Refuse rather than silently posting them, mirroring the bot path.
    if (postAsRich) {
        // Only locally-stored files are refused: web media (HTTP/HTTPS) is embedded in the
        // rich markdown by URL, so it isn't a "local upload" and mustn't trip this guard.
        const hasLocalUpload = [...photoAndVideoFiles, ...gifFiles, ...docFiles].some(f => f.isLocal);
        if (hasLocalUpload) throw new Error("RICH_LOCAL_MEDIA");
        if (richMarkdown.length > 0) {
            const msg = await client.sendRichMessage(peer, {
                content: { type: "markdown", content: richMarkdown },
                silent,
                schedule: scheduleDate,
                threadId,
            });
            result = { link: buildPostLinkFromChatId(channel.chatId, msg.id, topicId), messageId: msg.id };
            firstMsg = msg;
        }
    } else {
        // ── Photos and videos: grouped into one album ─────────────────────────
        if (photoAndVideoFiles.length > 0) {
            const msg = await sendBatch(photoAndVideoFiles, false, text);
            result = { link: buildPostLinkFromChatId(channel.chatId, msg.id, topicId), messageId: msg.id };
            if (!firstMsg) firstMsg = msg;
            captionConsumed = true;
        }

        // ── GIFs: each sent individually (must NOT be mixed with videos) ──────
        for (const gif of gifFiles) {
            const caption = captionConsumed ? "" : text;
            const msg = await sendBatch([gif], false, caption);
            if (!result) result = { link: buildPostLinkFromChatId(channel.chatId, msg.id, topicId), messageId: msg.id };
            if (!firstMsg) firstMsg = msg;
            captionConsumed = true;
        }

        // ── Documents (PDFs + uncommented .md embeds): grouped as documents ───
        if (docFiles.length > 0) {
            const caption = captionConsumed ? "" : text;
            const msg = await sendBatch(docFiles, true, caption);
            if (!result) result = { link: buildPostLinkFromChatId(channel.chatId, msg.id, topicId), messageId: msg.id };
            if (!firstMsg) firstMsg = msg;
            captionConsumed = true;
        }

        // ── Text-only (no media consumed the caption) ─────────────────────────
        if (!captionConsumed && text.length > 0) {
            const msg = await client.sendText(peer, htmlText(text), { silent, schedule: scheduleDate, threadId });
            result = { link: buildPostLinkFromChatId(channel.chatId, msg.id, topicId), messageId: msg.id };
            if (!firstMsg) firstMsg = msg;
        }
    }

    // For scheduled posts the link built above points at the scheduled-queue id, not the
    // eventual published id. Record what we need to resolve it later.
    if (scheduleDate && result && firstMsg) {
        result.scheduled = {
            chatId: channel.chatId,
            topicId,
            scheduledMsgId: firstMsg.id,
            scheduledDate: Math.floor(firstMsg.date.getTime() / 1000),
            text: firstMsg.text ?? "",
        };
    }

    if (treatMdEmbedsAsComments && result && mdEmbeds.length > 0 && !scheduleDate) {
        onProgress?.();
        const commentLinks: string[] = [];
        for (const mdFile of mdEmbeds) {
            const mdContent = await app.vault.read(mdFile);
            const { body: mdBody } = extractFrontmatter(mdContent);
            const formattedMdContent = mdToTelegramHtml(mdBody);
            // Comments follow the post method: rich for "account-rich", classic HTML otherwise.
            const richMdComment = postAsRich ? obsidianToRichMarkdown(mdBody) : "";
            if (!formattedMdContent.length && !richMdComment.length) continue;
            const commentLink = await sendCommentViaAccount(client, channel.chatId, result.messageId, formattedMdContent, richMdComment, silent);
            if (commentLink) commentLinks.push(commentLink);
        }
        if (commentLinks.length > 0) result = { ...result, commentLinks };
    }

    return result;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function sendNoteToTelegram(
    app: App,
    file: TFile,
    tg_channel: TelegramChannel,
    settings: TelegramSettings,
    secrets: TelegramSecrets,
    silent: boolean,
    attachUnderText: boolean,
    treatMdEmbedsAsComments: boolean,
    updateLink?: string,
    scheduleDate?: Date,
    onProgress?: () => void,
    postAsRich = false,
): Promise<{ links: string[]; commentLinks: string[]; errors: Error[]; scheduled: ScheduledSendInfo[] }> {
    const channel = { ...tg_channel, chatId: resolveChatId(tg_channel.chatId) };
    const content = await app.vault.read(file);
    const { body } = extractFrontmatter(content);

    // ── Update Existing Post ──────────────────────────────────────────────────

    if (updateLink && updateLink !== "none") {
        const msgIdMatch = updateLink.match(/\/(\d+)\/?$/);
        const messageId = msgIdMatch ? parseInt(msgIdMatch[1], 10) : null;

        if (messageId) {
            const client = await createClient(secrets.telegramSession, secrets.telegramApiId, secrets.telegramApiHash);
            try {
                const peer = peerFor(channel.chatId);
                try {
                    if (postAsRich) {
                        // High-level editMessage has no rich support; the raw messages.editMessage
                        // carries a richMessage field (inputRichMessageMarkdown) — use it directly.
                        const richMarkdown = obsidianToRichMarkdown(body);
                        await client.call({
                            _: "messages.editMessage",
                            peer: await client.resolvePeer(peer),
                            id: messageId,
                            richMessage: { _: "inputRichMessageMarkdown", markdown: richMarkdown },
                        });
                    } else {
                        await client.editMessage({ chatId: peer, message: messageId, text: htmlText(mdToTelegramHtml(body)) });
                    }
                } catch (err) {
                    if (errMessage(err).includes("MESSAGE_NOT_MODIFIED")) {
                        return { links: [updateLink], commentLinks: [], errors: [new Error("MESSAGE_NOT_MODIFIED")], scheduled: [] };
                    }
                    throw err;
                }
            } finally {
                await client.destroy();
            }
            return { links: [updateLink], commentLinks: [], errors: [], scheduled: [] };
        }
    }

    // ── Split body and send each part ─────────────────────────────────────────

    const parts = splitBodyByMarkers(body);
    const effectiveParts = parts.length > 0 ? parts : [body];

    const links: string[] = [];
    const commentLinks: string[] = [];
    const errors: Error[] = [];
    const scheduled: ScheduledSendInfo[] = [];

    const client = await createClient(secrets.telegramSession, secrets.telegramApiId, secrets.telegramApiHash);
    try {
        for (const part of effectiveParts) {
            try {
                const result = await sendPartViaAccount(app, part, channel, client, silent, attachUnderText, file, treatMdEmbedsAsComments, postAsRich, scheduleDate, onProgress);
                if (result) {
                    links.push(result.link);
                    if (result.commentLinks?.length) commentLinks.push(...result.commentLinks);
                    if (result.scheduled) scheduled.push(result.scheduled);
                }
            } catch (err) {
                errors.push(err instanceof Error ? err : new Error(String(err)));
            }
        }
    } finally {
        await client.destroy();
    }

    return { links, commentLinks, errors, scheduled };
}

// Edits pre-written comments in-place using the provided stored comment links
// (caller is responsible for filtering/ordering them). Does NOT touch the post.
export async function editNoteCommentsOnly(
    app: App,
    file: TFile,
    secrets: TelegramSecrets,
    commentLinks: string[],
    silent: boolean,
    embedOffset = 0,
    postAsRich = false,
): Promise<{ errors: Error[] }> {
    const content = await app.vault.read(file);
    const { body } = extractFrontmatter(content);
    const { mdEmbeds } = collectMediaFiles(app, body, file);

    const storedLinks = commentLinks;
    if (storedLinks.length === 0 || mdEmbeds.length === 0) return { errors: [] };

    const client = await createClient(secrets.telegramSession, secrets.telegramApiId, secrets.telegramApiHash);
    try {
        let anyChanged = false;
        const limit = Math.min(mdEmbeds.length - embedOffset, storedLinks.length);
        for (let i = 0; i < limit; i++) {
            const mdContent = await app.vault.read(mdEmbeds[i + embedOffset]);
            const { body: mdBody } = extractFrontmatter(mdContent);
            const formattedContent = mdToTelegramHtml(mdBody);
            const richMarkdown = postAsRich ? obsidianToRichMarkdown(mdBody) : "";
            if (!formattedContent.length && !richMarkdown.length) continue;

            const parsed = parseLinkComponents(storedLinks[i]);
            if (!parsed) continue;

            try {
                if (richMarkdown.length > 0) {
                    // Rich comment edit: raw messages.editMessage carries the richMessage field.
                    await client.call({
                        _: "messages.editMessage",
                        peer: await client.resolvePeer(peerFor(parsed.chatId)),
                        id: parsed.messageId,
                        richMessage: { _: "inputRichMessageMarkdown", markdown: richMarkdown },
                    });
                } else {
                    await client.editMessage({ chatId: peerFor(parsed.chatId), message: parsed.messageId, text: htmlText(formattedContent) });
                }
                anyChanged = true;
            } catch (err) {
                if (!errMessage(err).includes("MESSAGE_NOT_MODIFIED")) throw err;
            }
        }
        if (!anyChanged) return { errors: [new Error("MESSAGE_NOT_MODIFIED")] };
        return { errors: [] };
    } finally {
        await client.destroy();
    }
}

// ─── Scheduled post link resolution ───────────────────────────────────────────

export interface ScheduledResolution {
    task: PendingScheduledLink;
    status: "resolved" | "pending" | "unresolved";
    link?: string;
    // When "pending": the actual send time currently set in Telegram's queue,
    // if it differs from task.scheduledDate (e.g. message was rescheduled).
    updatedScheduledDate?: number;
}

// Resolves published links for previously scheduled posts. For each task:
//   • still in the scheduled queue            → "pending"  (not sent yet)
//   • published message found (date + text)   → "resolved" (with link)
//   • gone from queue but not found in history → "unresolved" (cancelled/deleted)
// Tasks are grouped by peer so a single client connection serves the whole batch.
export async function resolveScheduledLinks(
    secrets: TelegramSecrets,
    tasks: PendingScheduledLink[],
): Promise<ScheduledResolution[]> {
    const resolutions: ScheduledResolution[] = [];
    if (tasks.length === 0) return resolutions;

    const byChat = new Map<string, PendingScheduledLink[]>();
    for (const task of tasks) {
        const group = byChat.get(task.chatId) ?? [];
        group.push(task);
        byChat.set(task.chatId, group);
    }

    const client = await createClient(secrets.telegramSession, secrets.telegramApiId, secrets.telegramApiHash);
    try {
        for (const [chatId, group] of byChat) {
            const peer = peerFor(chatId);
            try {
                // Messages still sitting in the scheduled queue, keyed by id → current send date.
                const ids = group.map(t2 => t2.scheduledMsgId);
                const scheduledQueue = new Map<number, number>();
                try {
                    const queued = await client.getScheduledMessages(peer, ids);
                    for (const m of queued) {
                        if (m) scheduledQueue.set(m.id, Math.floor(m.date.getTime() / 1000));
                    }
                } catch { /* scheduled fetch failed — treat all as left-the-queue below */ }

                for (const task of group) {
                    if (scheduledQueue.has(task.scheduledMsgId)) {
                        const queuedDate = scheduledQueue.get(task.scheduledMsgId)!;
                        const updatedScheduledDate = queuedDate !== task.scheduledDate ? queuedDate : undefined;
                        resolutions.push({ task, status: "pending", updatedScheduledDate });
                        continue;
                    }
                    // Left the queue → find the published message by send-time + text.
                    // Telegram publishes scheduled messages up to a few seconds after the
                    // exact scheduled time, so the published .date may differ by 1-2 s.
                    const DATE_SLACK = 10;
                    const published = await client.getHistory(peer, { limit: 50, offset: { id: 0, date: task.scheduledDate + DATE_SLACK + 1 } });
                    const match = published.find(m => {
                        const dateSec = Math.floor(m.date.getTime() / 1000);
                        return Math.abs(dateSec - task.scheduledDate) <= DATE_SLACK &&
                            (task.text ? m.text === task.text : !!m.media);
                    });
                    if (match) {
                        resolutions.push({ task, status: "resolved", link: buildPostLinkFromChatId(task.chatId, match.id, task.topicId) });
                    } else {
                        resolutions.push({ task, status: "unresolved" });
                    }
                }
            } catch {
                // Transient peer-level failure — keep these for the next tick.
                for (const task of group) resolutions.push({ task, status: "pending" });
            }
        }
    } finally {
        await client.destroy();
    }
    return resolutions;
}
