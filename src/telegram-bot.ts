// telegram-bot.ts
// Telegram Bot API send path — used when a preset posts via a "bot" or "bot-rich" method.
// Self-contained: only imports from markdown.ts and Obsidian's API.

import { App, TFile, Notice, requestUrl } from "obsidian";
import { TelegramChannel, TelegramSettings } from "./types";
import { mdToBotApiHtml, obsidianToRichMarkdown, isRichEmbeddableUrl } from "./markdown";
import { parseSplitPosts, findPostContentForLink, hasSplitMarkers } from "./split";
import { t } from "../lang/helpers";

// ─── Internal types ───────────────────────────────────────────────────────────

interface SendResult {
    link: string;
    messageId: number;
    commentLinks?: string[];
}

interface MediaFile {
    name: string;
    extension: string;
    isLocal: boolean;   // true for vault files, false for remote HTTP(S) media
    url?: string;       // set for remote media: the HTTP(S) source, passed to the Bot API as-is
    getBlob: () => Promise<Blob>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "mkv", "webm"]);
// Telegram media groups (albums) hold at most 10 items; more than that splits across
// messages, which the classic-post single-message guard treats as unpostable.
const ALBUM_LIMIT = 10;
const SUPPORTED_MEDIA_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "pdf", ...VIDEO_EXTS]);

// ─── Frontmatter extraction ───────────────────────────────────────────────────

function extractFrontmatter(content: string): { body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    return { body: match ? content.slice(match[0].length) : content };
}

// Strips HTML tags to recover the visible text. A single pass of /<[^>]+>/g can leave
// a dangerous sequence behind (e.g. "<<b>script>" -> "<script>"), so repeat until the
// string stops changing.
function stripHtmlTags(input: string): string {
    let previous: string;
    do {
        previous = input;
        input = input.replace(/<[^>]+>/g, "");
    } while (input !== previous);
    return input;
}

// ─── Post link builder ────────────────────────────────────────────────────────

function buildBotPostLink(chatId: string, messageId: number): string {
    if (chatId.startsWith("@")) return `https://t.me/${chatId.slice(1)}/${messageId}`;
    const channelId = String(chatId).replace(/^-100/, "");
    return `https://t.me/c/${channelId}/${messageId}`;
}

// ─── Chat ID normalisation ────────────────────────────────────────────────────

function resolveChatId(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith("@") || /^-?\d+$/.test(trimmed)) return trimmed;
    return `@${trimmed}`;
}

// ─── Media collection ─────────────────────────────────────────────────────────

function collectBotMedia(app: App, body: string, sourceFile: TFile, postAsRich = false): { attachments: MediaFile[]; mdEmbeds: TFile[] } {
    const wikilinkRegex = /!\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;
    const mdLinkRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
    const reverseMdLinkRegex = /!\(([^)]+)\)\[[^\]]*\]/g;

    const seen = new Set<string>();
    const attachments: MediaFile[] = [];
    const mdEmbeds: TFile[] = [];

    const processLinkpath = (rawPath: string) => {
        let cleanPath = rawPath.split(/\s+"/)[0].split(/[?#]/)[0].trim();

        if (/^https?:\/\//i.test(cleanPath)) {
            // In the Rich Markdown path, rich-embeddable HTTP(S) media (images/video/audio/
            // gif) is carried inside the markdown as a media block, so it must NOT also be
            // sent here — that would double-send it. In the classic path there's no such
            // block, so it's sent as a normal attachment (by URL — see the send helpers).
            if (postAsRich && isRichEmbeddableUrl(cleanPath)) return;
            if (!seen.has(cleanPath)) {
                seen.add(cleanPath);
                const ext = cleanPath.split('.').pop()?.toLowerCase() || "";
                if (SUPPORTED_MEDIA_EXTS.has(ext)) {
                    attachments.push({
                        name: cleanPath.split('/').pop() || `media.${ext}`,
                        extension: ext,
                        isLocal: false,
                        url: cleanPath,
                        getBlob: async () => {
                            const response = await requestUrl({ url: cleanPath });
                            return new Blob([response.arrayBuffer]);
                        }
                    });
                }
            }
            return;
        }

        try { cleanPath = decodeURIComponent(cleanPath); } catch { /* keep raw */ }

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

// Maps a file extension to the sendMediaGroup item type. Anything that isn't a
// photo or video (PDFs, .md attachments, …) is sent as a document.
function botMediaType(ext: string): "video" | "photo" | "document" {
    if (VIDEO_EXTS.has(ext)) return "video";
    if (["jpg", "jpeg", "png", "webp"].includes(ext)) return "photo";
    return "document";
}

// ─── Bot API call helpers ─────────────────────────────────────────────────────

function botUrl(token: string, method: string): string {
    return `https://api.telegram.org/bot${token}/${method}`;
}

async function callBotJson(token: string, method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await requestUrl({
        url: botUrl(token, method),
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        throw: false, // read the JSON error body ourselves instead of losing it to a thrown exception
    });
    const data = response.json as { ok: boolean; result: unknown; description?: string };
    if (!data.ok) throw new Error(data.description ?? `Bot API error: ${method}`);
    return data.result;
}

// Resolves a bot's display label from its token via the Bot API getMe method.
// Returns "First name (@username)" (either part omitted if absent). Throws on an
// invalid token so callers can surface the error.
export async function getBotInfo(token: string): Promise<string> {
    const me = await callBotJson(token, "getMe", {}) as { first_name?: string; username?: string };
    const name = me.first_name ?? "";
    const username = me.username ? ` (@${me.username})` : "";
    return `${name}${username}`.trim();
}

// FormData (multipart) cannot be passed to requestUrl whose body type is string|ArrayBuffer.
async function callBotFetch(token: string, method: string, form: FormData): Promise<unknown> {
    const response = await window.fetch(botUrl(token, method), { method: "POST", body: form });
    const data = await response.json() as { ok: boolean; result: unknown; description?: string };
    if (!data.ok) throw new Error(data.description ?? `Bot API error: ${method}`);
    return data.result;
}

// ─── Send functions ───────────────────────────────────────────────────────────

function baseBody(chatId: string, silent: boolean, topicId?: number): Record<string, unknown> {
    const body: Record<string, unknown> = { chat_id: chatId };
    if (silent) body.disable_notification = true;
    if (topicId) body.message_thread_id = topicId;
    return body;
}

async function sendTextBot(token: string, chatId: string, text: string, silent: boolean, topicId?: number): Promise<SendResult> {
    const result = await callBotJson(token, "sendMessage", {
        ...baseBody(chatId, silent, topicId),
        text,
        parse_mode: "HTML",
    }) as { chat: { id: number; username?: string }; message_id: number };
    return { link: buildBotPostLink(chatId, result.message_id), messageId: result.message_id };
}

// Sends text as a Rich Message (Bot API 10.1 — sendRichMessage). Rich Markdown
// preserves headings, tables, task lists, math, footnotes, etc. that the classic
// HTML path can't express.
async function sendRichTextBot(token: string, chatId: string, markdown: string, silent: boolean, topicId?: number): Promise<SendResult> {
    const result = await callBotJson(token, "sendRichMessage", {
        ...baseBody(chatId, silent, topicId),
        rich_message: { markdown },
    }) as { chat: { id: number; username?: string }; message_id: number };
    return { link: buildBotPostLink(chatId, result.message_id), messageId: result.message_id };
}

// Sends as a Rich Message when markdown is provided (the "bot + rich" method), or as a
// classic HTML message otherwise (the plain "bot" method). A failed Rich Message is NOT
// downgraded to HTML — the error propagates so the post isn't silently sent unformatted.
async function sendRichOrClassicText(token: string, chatId: string, markdown: string, html: string, silent: boolean, topicId?: number): Promise<SendResult> {
    if (markdown.length > 0) {
        return await sendRichTextBot(token, chatId, markdown, silent, topicId);
    }
    return await sendTextBot(token, chatId, html, silent, topicId);
}

// Appends a single-media field to a Bot API form. Remote media is passed as its URL so
// Telegram fetches it server-side (no download + re-upload); local media is uploaded as
// multipart file bytes.
async function appendMediaField(form: FormData, field: string, file: MediaFile): Promise<void> {
    if (file.url) form.append(field, file.url);
    else form.append(field, await file.getBlob(), file.name);
}

async function sendPhotoBot(token: string, chatId: string, file: MediaFile, caption: string, silent: boolean, attachUnderText: boolean, topicId?: number): Promise<SendResult> {
    const form = new FormData();
    Object.entries(baseBody(chatId, silent, topicId)).forEach(([k, v]) => form.append(k, String(v)));
    await appendMediaField(form, "photo", file);
    if (caption) { form.append("caption", caption); form.append("parse_mode", "HTML"); }
    if (attachUnderText) form.append("show_caption_above_media", "true");
    const result = await callBotFetch(token, "sendPhoto", form) as { chat: { id: number; username?: string }; message_id: number };
    return { link: buildBotPostLink(chatId, result.message_id), messageId: result.message_id };
}

async function sendVideoBot(token: string, chatId: string, file: MediaFile, caption: string, silent: boolean, attachUnderText: boolean, topicId?: number): Promise<SendResult> {
    const form = new FormData();
    Object.entries(baseBody(chatId, silent, topicId)).forEach(([k, v]) => form.append(k, String(v)));
    await appendMediaField(form, "video", file);
    if (caption) { form.append("caption", caption); form.append("parse_mode", "HTML"); }
    if (attachUnderText) form.append("show_caption_above_media", "true");
    const result = await callBotFetch(token, "sendVideo", form) as { chat: { id: number; username?: string }; message_id: number };
    return { link: buildBotPostLink(chatId, result.message_id), messageId: result.message_id };
}

async function sendAnimationBot(token: string, chatId: string, file: MediaFile, caption: string, silent: boolean, attachUnderText: boolean, topicId?: number): Promise<SendResult> {
    const form = new FormData();
    Object.entries(baseBody(chatId, silent, topicId)).forEach(([k, v]) => form.append(k, String(v)));
    await appendMediaField(form, "animation", file);
    if (caption) { form.append("caption", caption); form.append("parse_mode", "HTML"); }
    if (attachUnderText) form.append("show_caption_above_media", "true");
    const result = await callBotFetch(token, "sendAnimation", form) as { chat: { id: number; username?: string }; message_id: number };
    return { link: buildBotPostLink(chatId, result.message_id), messageId: result.message_id };
}

async function sendDocumentBot(token: string, chatId: string, file: MediaFile, caption: string, silent: boolean, attachUnderText: boolean, topicId?: number): Promise<SendResult> {
    const form = new FormData();
    Object.entries(baseBody(chatId, silent, topicId)).forEach(([k, v]) => form.append(k, String(v)));
    await appendMediaField(form, "document", file);
    if (caption) { form.append("caption", caption); form.append("parse_mode", "HTML"); }
    if (attachUnderText) form.append("show_caption_above_media", "true");
    const result = await callBotFetch(token, "sendDocument", form) as { chat: { id: number; username?: string }; message_id: number };
    return { link: buildBotPostLink(chatId, result.message_id), messageId: result.message_id };
}

async function sendMediaGroupBot(token: string, chatId: string, files: MediaFile[], caption: string, silent: boolean, attachUnderText: boolean, topicId?: number): Promise<SendResult> {
    const form = new FormData();
    Object.entries(baseBody(chatId, silent, topicId)).forEach(([k, v]) => form.append(k, String(v)));

    const mediaArray = await Promise.all(files.map(async (file, idx) => {
        // Remote media is referenced by URL (Telegram fetches it); local media is uploaded
        // as a multipart part and referenced via attach://.
        let media: string;
        if (file.url) {
            media = file.url;
        } else {
            const attachName = `file${idx}`;
            form.append(attachName, await file.getBlob(), file.name);
            media = `attach://${attachName}`;
        }
        const type = botMediaType(file.extension);
        // show_caption_above_media is only valid for photo/video items, not documents.
        const captionFields = idx === 0 && caption
            ? { caption, parse_mode: "HTML", ...(type === "document" ? {} : { show_caption_above_media: attachUnderText }) }
            : {};
        return { type, media, ...captionFields };
    }));

    form.append("media", JSON.stringify(mediaArray));
    const result = await callBotFetch(token, "sendMediaGroup", form) as Array<{ chat: { id: number; username?: string }; message_id: number }>;
    return { link: buildBotPostLink(chatId, result[0].message_id), messageId: result[0].message_id };
}

async function sendReplyBot(token: string, chatId: string, replyToMessageId: number, text: string, silent: boolean, topicId?: number): Promise<number> {
    const result = await callBotJson(token, "sendMessage", {
        ...baseBody(chatId, silent, topicId),
        reply_to_message_id: replyToMessageId,
        text,
        parse_mode: "HTML",
    }) as { message_id: number };
    return result.message_id;
}

// Rich Message reply — sendRichMessage uses a reply_parameters object rather than
// the reply_to_message_id field used by classic sendMessage.
async function sendRichReplyBot(token: string, chatId: string, replyToMessageId: number, markdown: string, silent: boolean, topicId?: number): Promise<number> {
    const result = await callBotJson(token, "sendRichMessage", {
        ...baseBody(chatId, silent, topicId),
        rich_message: { markdown },
        reply_parameters: { message_id: replyToMessageId },
    }) as { message_id: number };
    return result.message_id;
}

// Sends a comment reply as a Rich Message when markdown is provided (the "bot + rich"
// method), or as a classic HTML reply otherwise (the plain "bot" method). A failed Rich
// Message is NOT downgraded to HTML — the error propagates to the caller, which surfaces
// it; the comment is not sent unformatted.
async function sendRichOrClassicReply(token: string, chatId: string, replyToMessageId: number, markdown: string, html: string, silent: boolean, topicId?: number): Promise<number> {
    if (markdown.length > 0) {
        return await sendRichReplyBot(token, chatId, replyToMessageId, markdown, silent, topicId);
    }
    return await sendReplyBot(token, chatId, replyToMessageId, html, silent, topicId);
}

async function getLinkedChatId(token: string, chatId: string): Promise<number | null> {
    const result = await callBotJson(token, "getChat", { chat_id: chatId }) as { linked_chat_id?: number };
    return result.linked_chat_id ?? null;
}

async function findDiscussionMessageId(token: string, linkedChatId: number, channelMessageId: number): Promise<number | null> {
    const MAX_ATTEMPTS = 5;
    const DELAY_MS = 1500;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        await new Promise(resolve => window.setTimeout(resolve, DELAY_MS));
        try {
            const result = await callBotJson(token, "getUpdates", { limit: 100, allowed_updates: ["message"] }) as Array<{ message?: { chat: { id: number }; message_id: number; forward_origin?: { message_id?: number }; forward_from_message_id?: number } }>;
            for (const update of [...result].reverse()) {
                const msg = update.message;
                if (!msg || msg.chat.id !== linkedChatId) continue;
                const fwdId = msg.forward_origin?.message_id ?? msg.forward_from_message_id;
                if (fwdId === channelMessageId) return msg.message_id;
            }
        } catch { /* retry */ }
    }
    return null;
}

// ─── Single-part send ─────────────────────────────────────────────────────────

async function sendPartViaBotApi(
    app: App,
    body: string,
    token: string,
    chatId: string,
    silent: boolean,
    attachUnderText: boolean,
    treatMdEmbedsAsComments: boolean,
    sourceFile: TFile,
    topicId?: number,
    postAsRich = false,
    commentsAsRich = false,
): Promise<SendResult | null> {
    const richMarkdown = obsidianToRichMarkdown(body);
    const htmlFallback = mdToBotApiHtml(body);
    // The "bot" method posts a regular (classic HTML) message; "bot + rich" posts a
    // Rich Message. Forcing empty markdown routes sendRichOrClassicText to the classic path.
    const postMarkdown = postAsRich ? richMarkdown : "";
    const { attachments, mdEmbeds } = collectBotMedia(app, body, sourceFile, postAsRich);

    const photoAndVideoFiles = attachments.filter(f =>
        ["jpg", "jpeg", "png", "webp"].includes(f.extension) || VIDEO_EXTS.has(f.extension)
    );
    const gifFiles = attachments.filter(f => f.extension === "gif");
    // PDFs always upload as documents; embedded .md files join them as document
    // attachments unless they're being sent as comments instead.
    const pdfFiles = attachments.filter(f => f.extension === "pdf");
    const mdDocFiles = treatMdEmbedsAsComments ? [] : mdEmbeds.map(f => mdEmbedToMedia(app, f));
    const docFiles = [...pdfFiles, ...mdDocFiles];

    // richMarkdown carries the post text AND any HTTP(S) media embeds (as rich media
    // blocks). uploadMedia is only the locally-stored / non-rich files that the Rich
    // Message API can't reference by URL and must be uploaded separately.
    const hasPostText = postMarkdown.length > 0 || htmlFallback.length > 0;
    const uploadFiles = [...photoAndVideoFiles, ...gifFiles, ...docFiles];
    const hasUploadMedia = uploadFiles.length > 0;
    const hasLocalUpload = uploadFiles.some(f => f.isLocal);

    // The Bot API caps media captions at 1024 chars (bots get no Premium bump). The
    // length is counted on the visible text, so strip HTML tags before measuring.
    const BOT_CAPTION_LIMIT = 1024;
    const captionPlainLength = stripHtmlTags(htmlFallback).length;

    // Uploads the local / non-rich media files. The post text rides as the caption of the
    // first message produced (consumed once); the rest go caption-less. attachUnderText
    // positions the caption above photo/video media. Returns the first message's SendResult.
    async function sendUploadMedia(caption: string): Promise<SendResult | null> {
        let mediaResult: SendResult | null = null;
        let captionLeft = caption;
        const nextCaption = () => { const c = captionLeft; captionLeft = ""; return c; };

        if (photoAndVideoFiles.length > 0) {
            const firstBatch = photoAndVideoFiles.slice(0, 10);
            const remaining = photoAndVideoFiles.slice(10);
            const cap = nextCaption();
            if (firstBatch.length === 1) {
                const f = firstBatch[0];
                mediaResult = VIDEO_EXTS.has(f.extension)
                    ? await sendVideoBot(token, chatId, f, cap, silent, attachUnderText, topicId)
                    : await sendPhotoBot(token, chatId, f, cap, silent, attachUnderText, topicId);
            } else {
                mediaResult = await sendMediaGroupBot(token, chatId, firstBatch, cap, silent, attachUnderText, topicId);
            }
            for (const f of remaining) {
                await (VIDEO_EXTS.has(f.extension)
                    ? sendVideoBot(token, chatId, f, "", silent, false, topicId)
                    : sendPhotoBot(token, chatId, f, "", silent, false, topicId));
            }
        }

        for (const gif of gifFiles) {
            const r = await sendAnimationBot(token, chatId, gif, nextCaption(), silent, attachUnderText, topicId);
            if (!mediaResult) mediaResult = r;
        }

        if (docFiles.length > 0) {
            const firstBatch = docFiles.slice(0, 10);
            const remainingDocs = docFiles.slice(10);
            // Documents don't support show_caption_above_media, so attachUnderText is false here.
            const docResult = firstBatch.length === 1
                ? await sendDocumentBot(token, chatId, firstBatch[0], nextCaption(), silent, false, topicId)
                : await sendMediaGroupBot(token, chatId, firstBatch, nextCaption(), silent, false, topicId);
            if (!mediaResult) mediaResult = docResult;
            for (const doc of remainingDocs) await sendDocumentBot(token, chatId, doc, "", silent, false, topicId);
        }

        return mediaResult;
    }

    let result: SendResult | null = null;

    if (postAsRich) {
        // ── Rich Message path ("bot + rich") ─────────────────────────────────────
        // Rich Messages can only reference web media (embedded in the markdown); local
        // uploads aren't supported, so refuse rather than silently posting them separately.
        if (hasLocalUpload) throw new Error("RICH_LOCAL_MEDIA");
        // Any remaining (web, non-rich-embeddable) uploads go as separate caption-less
        // messages around the rich text.
        if (!hasUploadMedia) {
            if (hasPostText) result = await sendRichOrClassicText(token, chatId, postMarkdown, htmlFallback, silent, topicId);
        } else if (!hasPostText) {
            result = await sendUploadMedia("");
        } else if (attachUnderText) {
            result = await sendRichOrClassicText(token, chatId, postMarkdown, htmlFallback, silent, topicId);
            await sendUploadMedia("");
        } else {
            result = await sendUploadMedia("");
            await sendRichOrClassicText(token, chatId, postMarkdown, htmlFallback, silent, topicId);
        }
    } else {
        // ── Classic HTML path ("bot") ────────────────────────────────────────────
        // A classic post must be a single message; if the attachments would produce more
        // than one, refuse rather than fragmenting the post. Separate messages come from:
        // the photo+video album, each GIF (its own message — animations can't be grouped),
        // and the document album (PDFs + .md); an album holds at most ALBUM_LIMIT items, so
        // >10 of one kind splits too. (Photo+video alone is one album on the Bot API, unlike
        // the User API, so it's allowed here.)
        const messageCount = Math.ceil(photoAndVideoFiles.length / ALBUM_LIMIT) + gifFiles.length + Math.ceil(docFiles.length / ALBUM_LIMIT);
        if (messageCount > 1) throw new Error("MIXED_MEDIA_CLASSIC");
        // All attachments carry the post text as the caption of the first message; a
        // caption over the Bot API limit is refused rather than truncated or split off.
        if (!hasUploadMedia) {
            if (hasPostText) result = await sendRichOrClassicText(token, chatId, "", htmlFallback, silent, topicId);
        } else {
            if (hasPostText && captionPlainLength > BOT_CAPTION_LIMIT) throw new Error("MEDIA_CAPTION_TOO_LONG");
            result = await sendUploadMedia(hasPostText ? htmlFallback : "");
        }
    }

    const commentLinks: string[] = [];
    if (treatMdEmbedsAsComments && result && mdEmbeds.length > 0) {
        const linkedChatId = await getLinkedChatId(token, chatId).catch(() => null);
        for (const mdFile of mdEmbeds) {
            const mdContent = await app.vault.read(mdFile);
            const { body: mdBody } = extractFrontmatter(mdContent);
            const commentHtml = mdToBotApiHtml(mdBody);
            const commentMd = commentsAsRich ? obsidianToRichMarkdown(mdBody) : "";
            if (!commentHtml.length && !commentMd.length) continue;

            // A comment failure must not lose the main post's link, so isolate it.
            try {
                if (linkedChatId !== null) {
                    const discussionId = await findDiscussionMessageId(token, linkedChatId, result.messageId);
                    if (discussionId !== null) {
                        const commentMsgId = await sendRichOrClassicReply(token, String(linkedChatId), discussionId, commentMd, commentHtml, silent);
                        commentLinks.push(buildBotPostLink(String(linkedChatId), commentMsgId));
                    } else {
                        new Notice(t.NOTICE_COMMENT_DISCUSSION_NOT_FOUND);
                    }
                } else {
                    const commentMsgId = await sendRichOrClassicReply(token, chatId, result.messageId, commentMd, commentHtml, silent, topicId);
                    commentLinks.push(buildBotPostLink(chatId, commentMsgId));
                }
            } catch (err) {
                new Notice(t.NOTICE_COMMENT_FAILED.replace("{error}", err instanceof Error ? err.message : String(err)));
            }
        }
    }

    return result ? { ...result, commentLinks } : null;
}

// ─── Edit helpers ─────────────────────────────────────────────────────────────

// Editing with identical content makes the Bot API throw "message is not modified".
// That's a no-op success from the user's point of view, so callers treat it as such.
function isNotModifiedError(err: unknown): boolean {
    return (err instanceof Error ? err.message : String(err)).toLowerCase().includes("message is not modified");
}

async function editMessageBot(token: string, chatId: string, messageId: number, text: string): Promise<void> {
    try {
        await callBotJson(token, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: "HTML",
        });
    } catch (err) {
        if (isNotModifiedError(err)) return;
        const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
        if (msg.includes("there is no text in the message to edit")) {
            try {
                await callBotJson(token, "editMessageCaption", {
                    chat_id: chatId,
                    message_id: messageId,
                    caption: text,
                    parse_mode: "HTML",
                });
            } catch (capErr) {
                if (isNotModifiedError(capErr)) return;
                throw capErr;
            }
        } else {
            throw err;
        }
    }
}

// Edits a message that was published as a Rich Message (Bot API 10.1 — editMessageText
// with a rich_message field instead of text/parse_mode). There is no time limit on a
// bot editing its own messages, and this works for channel posts the bot can edit.
async function editRichMessageBot(token: string, chatId: string, messageId: number, markdown: string): Promise<void> {
    try {
        await callBotJson(token, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            rich_message: { markdown },
        });
    } catch (err) {
        if (isNotModifiedError(err)) return;
        throw err;
    }
}

// Edits a classic message to carry media (editMessageMedia). Used when a note gains an
// attachment after the post was created, so adding e.g. a photo on edit actually shows it
// instead of only updating the text. Local media is uploaded as a multipart part and
// referenced via attach://; remote media is passed by URL. The note text rides as the
// media caption. Note: the Bot API can only *replace* media on a message that already has
// media of a compatible kind — Telegram rejects turning a pure-text message into a media
// message, and that error is surfaced to the caller rather than swallowed.
async function editMessageMediaBot(token: string, chatId: string, messageId: number, file: MediaFile, caption: string, attachUnderText: boolean): Promise<void> {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("message_id", String(messageId));

    const type = file.extension === "gif" ? "animation" : botMediaType(file.extension);
    const inputMedia: Record<string, unknown> = { type, media: "" };
    if (caption) { inputMedia.caption = caption; inputMedia.parse_mode = "HTML"; }
    // show_caption_above_media is only valid for photo/video/animation, not documents.
    if (caption && attachUnderText && type !== "document") inputMedia.show_caption_above_media = true;

    if (file.url) {
        inputMedia.media = file.url;
    } else {
        form.append("file0", await file.getBlob(), file.name);
        inputMedia.media = "attach://file0";
    }
    form.append("media", JSON.stringify(inputMedia));

    try {
        await callBotFetch(token, "editMessageMedia", form);
    } catch (err) {
        if (isNotModifiedError(err)) return;
        throw err;
    }
}

// Edits comments that were published via the Bot API, in place — the bot counterpart
// to editNoteCommentsOnly. Each stored comment is matched to an embedded .md file by
// order (offset by embedOffset). asRich edits as a Rich Message ("bot + rich" method),
// otherwise as classic HTML; a failed rich edit is reported as an error, not downgraded
// to HTML. Entries may be null to keep alignment with the embeds when a link couldn't
// be parsed.
export async function editNoteCommentsViaBotApi(
    app: App,
    file: TFile,
    token: string,
    comments: Array<{ chatId: string; messageId: number } | null>,
    asRich: boolean,
    embedOffset = 0,
): Promise<{ errors: Error[] }> {
    const content = await app.vault.read(file);
    const { body } = extractFrontmatter(content);
    const { mdEmbeds } = collectBotMedia(app, body, file, asRich);

    if (comments.length === 0 || mdEmbeds.length === 0) return { errors: [] };

    const errors: Error[] = [];
    const limit = Math.min(mdEmbeds.length - embedOffset, comments.length);
    for (let i = 0; i < limit; i++) {
        const target = comments[i];
        if (!target) continue;
        const mdContent = await app.vault.read(mdEmbeds[i + embedOffset]);
        const { body: mdBody } = extractFrontmatter(mdContent);
        const chatId = resolveChatId(String(target.chatId));
        try {
            if (asRich) {
                const markdown = obsidianToRichMarkdown(mdBody);
                if (!markdown.length) continue;
                await editRichMessageBot(token, chatId, target.messageId, markdown);
            } else {
                const html = mdToBotApiHtml(mdBody);
                if (!html.length) continue;
                await editMessageBot(token, chatId, target.messageId, html);
            }
        } catch (err) {
            errors.push(err instanceof Error ? err : new Error(String(err)));
        }
    }
    return { errors };
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function sendNoteViaBotApi(
    app: App,
    file: TFile,
    channel: TelegramChannel,
    _settings: TelegramSettings,
    silent: boolean,
    attachUnderText: boolean,
    treatMdEmbedsAsComments: boolean,
    updateLink?: string,
    postAsRich = false,
    commentsAsRich = false,
): Promise<{ links: string[]; commentLinks: string[]; errors: Error[]; postLinks: string[][] }> {
    const token = channel.botToken ?? "";
    if (!token) throw new Error(t.ERR_BOT_TOKEN_NOT_CONFIGURED);

    const targets = channel.chatTargets?.length > 0
        ? channel.chatTargets
        : (channel.chatId ? [{ id: channel.chatId, title: channel.chatTitle }] : []);

    if (targets.length === 0) throw new Error(t.ERR_NO_CHAT_TARGETS);

    const content = await app.vault.read(file);
    const { body } = extractFrontmatter(content);

    // ── Edit existing message ─────────────────────────────────────────────────

    if (updateLink && updateLink !== "none") {
        const msgIdMatch = updateLink.match(/\/(\d+)\/?$/);
        const messageId = msgIdMatch ? parseInt(msgIdMatch[1], 10) : null;
        // When the note is split, edit from the specific part whose split marker records this
        // link. If markers exist but none carries the link, there's nothing to map the edit to
        // — surface it so the user adds the link to the intended split command. A note without
        // any split markers edits from its whole body (legacy single-post note).
        let editBody = body;
        if (hasSplitMarkers(body)) {
            const matched = findPostContentForLink(body, updateLink);
            if (matched === null) throw new Error("SPLIT_LINK_NOT_FOUND");
            editBody = matched;
        }
        if (messageId) {
            // The edit follows the preset's *current* method: a "bot + rich" preset
            // re-publishes the edit as a Rich Message, a plain "bot" preset as HTML. The
            // user picks the style at edit time by choosing which method they edit with. A
            // failed rich edit is NOT downgraded to HTML — the error propagates instead.
            const richMarkdown = postAsRich ? obsidianToRichMarkdown(editBody) : "";
            const htmlContent = mdToBotApiHtml(editBody);
            // For the classic method, attach the note's media so adding e.g. a photo on edit
            // actually shows up (via editMessageMedia). Only a single attachment can ride on
            // an edit — an album can't be formed this way — so with 0 or >1 attachments we
            // edit the text/caption only, the pre-existing behaviour. Rich messages carry
            // their (web) media inside the markdown, so the rich edit needs nothing extra.
            const { attachments } = postAsRich ? { attachments: [] as MediaFile[] } : collectBotMedia(app, editBody, file, false);
            const singleMedia = attachments.length === 1 ? attachments[0] : null;
            for (const target of targets) {
                const chatId = resolveChatId(target.id);
                if (richMarkdown.length > 0) {
                    await editRichMessageBot(token, chatId, messageId, richMarkdown);
                } else if (singleMedia) {
                    await editMessageMediaBot(token, chatId, messageId, singleMedia, htmlContent, attachUnderText);
                } else {
                    await editMessageBot(token, chatId, messageId, htmlContent);
                }
            }
            return { links: [updateLink], commentLinks: [], errors: [], postLinks: [] };
        }
    }

    // ── Send all parts to all targets ─────────────────────────────────────────

    const posts = parseSplitPosts(body);
    const effectiveParts = posts.length > 0 ? posts.map(p => p.content) : [body];

    const links: string[] = [];
    const commentLinks: string[] = [];
    const errors: Error[] = [];
    // Published links per part (aligned to parseSplitPosts order), collecting every target's
    // link for a given part so they can be recorded together in that part's split marker.
    const postLinks: string[][] = effectiveParts.map(() => []);

    for (const target of targets) {
        const chatId = resolveChatId(target.id);
        const topicId = target.topicId;

        for (let i = 0; i < effectiveParts.length; i++) {
            try {
                const result = await sendPartViaBotApi(
                    app, effectiveParts[i], token, chatId, silent, attachUnderText,
                    treatMdEmbedsAsComments, file, topicId, postAsRich, commentsAsRich,
                );
                if (result) {
                    links.push(result.link);
                    postLinks[i].push(result.link);
                    if (result.commentLinks?.length) commentLinks.push(...result.commentLinks);
                }
            } catch (err) {
                errors.push(err instanceof Error ? err : new Error(String(err)));
            }
        }
    }

    return { links, commentLinks, errors, postLinks };
}
