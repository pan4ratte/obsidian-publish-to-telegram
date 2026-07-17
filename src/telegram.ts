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

// InputMedia factories for uploaded rich-message attachments; the union is what
// sendRichMessage's `attachments` map accepts (InputRichMessageMedia).
type RichAttachment = ReturnType<typeof InputMedia.photo> | ReturnType<typeof InputMedia.video> | ReturnType<typeof InputMedia.audio>;

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
const RICH_PHOTO_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);
const RICH_AUDIO_EXTS = new Set(["mp3", "ogg", "m4a", "wav", "flac"]);
// Telegram media groups (albums) hold at most 10 items; more than that splits across
// messages, which the classic-post single-message guard treats as unpostable.
const ALBUM_LIMIT = 10;

// The rich-message reference kind (tg://<kind>?id=…) for a local file extension. GIFs
// ride as videos (animations). Returns null for anything a rich message can't embed
// inline (e.g. PDFs — there's no document reference).
type RichKind = "photo" | "video" | "audio";
function richKindForExt(ext: string): RichKind | null {
    if (RICH_PHOTO_EXTS.has(ext)) return "photo";
    if (VIDEO_EXTS.has(ext) || ext === "gif") return "video";
    if (RICH_AUDIO_EXTS.has(ext)) return "audio";
    return null;
}

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

interface RichMediaItem { id: string; kind: RichKind; file: MediaFile; }

// For a rich (account) post, rewrites each LOCAL media embed (photo/video/GIF/audio) into a
// `tg://<kind>?id=…` reference and returns the files to upload as rich-message attachments —
// the User-API rich message can carry uploaded media, unlike the Bot API. Web (HTTP/S)
// embeds are left as their URL (Telegram renders them inline). `.md` embeds are left alone
// (they're handled by the comment path and stripped from the body afterwards). A local
// document (e.g. PDF) can't be embedded inline, so it sets `hasUnsupportedLocal` and the
// caller refuses. Only the returned `body` should be fed to obsidianToRichMarkdown.
function collectRichMedia(app: App, body: string, sourceFile: TFile): { body: string; media: RichMediaItem[]; hasUnsupportedLocal: boolean } {
    const media: RichMediaItem[] = [];
    let hasUnsupportedLocal = false;
    let counter = 0;

    // Given a raw embed target, returns the `![](tg://…)` replacement for a local media
    // file, or null to leave the embed text untouched (web media, .md, unresolved, …).
    const refFor = (rawPath: string): string | null => {
        let cleanPath = rawPath.split(/\s+["']/)[0].split(/[?#]/)[0].trim();
        if (/^https?:\/\//i.test(cleanPath)) return null;               // web media: keep the URL
        try { cleanPath = decodeURIComponent(cleanPath); } catch { /* keep raw path */ }
        const resolved = app.metadataCache.getFirstLinkpathDest(cleanPath, sourceFile.path);
        if (!(resolved instanceof TFile)) return null;
        const kind = richKindForExt(resolved.extension);
        if (!kind) {
            // A document (PDF) is media but has no rich reference; .md is an embedded note
            // left to the comment path. Only the former should block the post.
            if (resolved.extension !== "md") hasUnsupportedLocal = true;
            return null;
        }
        const id = `m${counter++}`;
        media.push({
            id, kind,
            file: {
                name: resolved.name,
                extension: resolved.extension,
                isLocal: true,
                getBlob: async () => new Blob([await app.vault.readBinary(resolved)]),
            },
        });
        return `![](tg://${kind}?id=${id})`;
    };

    const wikilinkRegex = /!\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;
    const mdLinkRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
    const reverseMdLinkRegex = /!\(([^)]+)\)\[[^\]]*\]/g;

    const rewritten = body
        .replace(wikilinkRegex, (m, p1: string) => refFor(p1) ?? m)
        .replace(mdLinkRegex, (m, p1: string) => refFor(p1) ?? m)
        .replace(reverseMdLinkRegex, (m, p1: string) => refFor(p1) ?? m);

    return { body: rewritten, media, hasUnsupportedLocal };
}

// Builds an uploaded-media InputMedia for a rich attachment of the given kind.
async function toRichAttachment(item: RichMediaItem): Promise<RichAttachment> {
    const file = new File([await item.file.getBlob()], item.file.name);
    if (item.kind === "photo") return InputMedia.photo(file);
    if (item.kind === "audio") return InputMedia.audio(file, { fileName: item.file.name });
    if (item.file.extension === "gif") return InputMedia.animation(file, { fileName: item.file.name });
    return InputMedia.video(file, { fileName: item.file.name });
}

// Builds a rich message's markdown + uploaded-media attachments from a note body: local
// media embeds become tg://…?id= references backed by the `attachments` map, web embeds
// stay as URLs. `hasUnsupportedLocal` flags a local document (PDF) the caller may refuse.
// Used for both the main post and md-embed comments (each resolved against its own file).
async function buildRichMessageContent(app: App, body: string, sourceFile: TFile): Promise<{ markdown: string; attachments?: Record<string, RichAttachment>; hasUnsupportedLocal: boolean }> {
    const { body: richBody, media, hasUnsupportedLocal } = collectRichMedia(app, body, sourceFile);
    const markdown = obsidianToRichMarkdown(richBody);
    let attachments: Record<string, RichAttachment> | undefined;
    if (media.length) {
        const entries = await Promise.all(media.map(async m => [m.id, await toRichAttachment(m)] as const));
        attachments = Object.fromEntries(entries);
    }
    return { markdown, attachments, hasUnsupportedLocal };
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
    // Both local and remote media are uploaded as bytes. (mtcute can send a URL string as
    // inputMedia*External so Telegram fetches it, but that path is unreliable for user
    // accounts — it's the Bot API that handles remote media by URL, in telegram-bot.ts.)
    const source = new File([await file.getBlob()], file.name);
    const ext = file.extension.toLowerCase();
    if (asDocument) return InputMedia.document(source, { fileName: file.name, caption });
    if (VIDEO_EXTS.has(ext)) return InputMedia.video(source, { fileName: file.name, caption });
    if (ext === "gif") return InputMedia.animation(source, { fileName: file.name, caption });
    if (["jpg", "jpeg", "png", "webp"].includes(ext)) return InputMedia.photo(source, { caption });
    return InputMedia.document(source, { fileName: file.name, caption });
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
            } else if (chat) {
                // Basic group upgraded to a supergroup stays in the dialog list as a dead
                // stub: `migratedTo` points at the new supergroup (which appears as its own
                // channel dialog) and `deactivated` is set. Posting to the stub fails, so
                // skip it. Also skip groups the user has left, and those where non-admins
                // are banned from sending messages.
                if (chat.migratedTo || chat.deactivated || chat.left) continue;
                if (!chat.creator && !chat.adminRights && chat.defaultBannedRights?.sendMessages) continue;
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
    richAttachments: Record<string, RichAttachment> | undefined,
    silent: boolean,
): Promise<string | null> {
    const channelPeer = peerFor(channelChatId);

    // Sends the comment as a Rich Message when rich markdown is provided ("account-rich"),
    // else as a classic HTML message. Both accept the same commentTo/replyTo/sendAs params.
    const sendComment = (params: { commentTo?: number; replyTo?: number; sendAs?: string | number; silent: boolean }): Promise<Message> =>
        richMarkdown.length > 0
            ? client.sendRichMessage(channelPeer, { content: { type: "markdown", content: richMarkdown, attachments: richAttachments }, ...params })
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

    // ── Rich post: send as a Rich Message ─────────────────────────────────────
    // Unlike the Bot API, a User-API rich message can carry uploaded (local) media: local
    // media embeds are rewritten to tg://…?id= references and uploaded as attachments, while
    // web embeds ride along as their URL. Only local documents (PDFs) can't be embedded.
    if (postAsRich) {
        const { markdown: richMarkdown, attachments: richAttachments, hasUnsupportedLocal } = await buildRichMessageContent(app, body, sourceFile);
        // A rich message can't embed a document: a local PDF (hasUnsupportedLocal), or — when
        // md embeds are attached as files rather than posted as comments — a local .md embed.
        if (hasUnsupportedLocal || (!treatMdEmbedsAsComments && mdEmbeds.length > 0)) throw new Error("RICH_LOCAL_DOC");
        if (richMarkdown.length > 0) {
            const msg = await client.sendRichMessage(peer, {
                content: { type: "markdown", content: richMarkdown, attachments: richAttachments },
                silent,
                schedule: scheduleDate,
                threadId,
            });
            result = { link: buildPostLinkFromChatId(channel.chatId, msg.id, topicId), messageId: msg.id };
            firstMsg = msg;
        }
    } else {
        // A classic-method post must be a single message; if the attachments would produce
        // more than one, it's refused up front (nothing is sent) rather than fragmenting the
        // post. Separate messages come from: the photo+video album, each GIF (its own message
        // — animations can't be grouped), and the document album (PDFs + .md). An album holds
        // at most ALBUM_LIMIT items, so >10 of one kind also splits across messages.
        // Additionally, the User API rejects a mixed photo+video album (MEDIA_INVALID), so
        // that can't be one post either. The user is told to use a rich method or split up.
        const hasPhoto = photoAndVideoFiles.some(f => ["jpg", "jpeg", "png", "webp"].includes(f.extension));
        const hasVideo = photoAndVideoFiles.some(f => VIDEO_EXTS.has(f.extension));
        const messageCount = Math.ceil(photoAndVideoFiles.length / ALBUM_LIMIT) + gifFiles.length + Math.ceil(docFiles.length / ALBUM_LIMIT);
        if (messageCount > 1 || (hasPhoto && hasVideo)) throw new Error("MIXED_MEDIA_CLASSIC");

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
            // Rich comments carry their own local media (resolved against the embedded note);
            // an unembeddable local document there is dropped, as comments are best-effort.
            let richMdComment = "";
            let richCommentAttachments: Record<string, RichAttachment> | undefined;
            if (postAsRich) {
                const built = await buildRichMessageContent(app, mdBody, mdFile);
                richMdComment = built.markdown;
                richCommentAttachments = built.attachments;
            }
            if (!formattedMdContent.length && !richMdComment.length) continue;
            const commentLink = await sendCommentViaAccount(client, channel.chatId, result.messageId, formattedMdContent, richMdComment, richCommentAttachments, silent);
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
                        // Web-media embeds ride inside the markdown (Telegram renders them inline),
                        // but Telegram's editMessage can't add UPLOADED local media to a message
                        // that was sent without media — doing so collapses the rich message into a
                        // classic post. So we keep it rich and skip local media, then report that a
                        // photo couldn't be added this way (the caller shows a notice). A local
                        // document is still refused up front, as on send.
                        const { media: skippedLocal, hasUnsupportedLocal } = collectRichMedia(app, body, file);
                        if (hasUnsupportedLocal) throw new Error("RICH_LOCAL_DOC");
                        const richMarkdown = obsidianToRichMarkdown(body);
                        await client.call({
                            _: "messages.editMessage",
                            peer: await client.resolvePeer(peer),
                            id: messageId,
                            richMessage: { _: "inputRichMessageMarkdown", markdown: richMarkdown },
                        });
                        if (skippedLocal.length > 0) {
                            return { links: [updateLink], commentLinks: [], errors: [new Error("RICH_EDIT_LOCAL_MEDIA")], scheduled: [] };
                        }
                    } else {
                        // Classic edit: attach the note's media so adding a photo (or other single
                        // attachment) to a previously text-only post actually shows up. Only one
                        // media can ride on an edit — an album can't be formed this way — so with
                        // multiple attachments we fall back to editing the text/caption only (the
                        // pre-existing behaviour), leaving any album media untouched.
                        const { attachments } = collectMediaFiles(app, body, file);
                        const html = mdToTelegramHtml(body);
                        if (attachments.length === 1) {
                            const f = attachments[0];
                            const media = await toInputMedia(f, f.extension === "pdf", html.length ? htmlText(html) : undefined);
                            await client.editMessage({ chatId: peer, message: messageId, media, invertMedia: attachUnderText && html.length > 0 });
                        } else {
                            await client.editMessage({ chatId: peer, message: messageId, text: htmlText(html) });
                        }
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
