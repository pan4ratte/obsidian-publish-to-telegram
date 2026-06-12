// telegram-bot.ts
// Telegram Bot API send path — used when a preset posts via a "bot" or "bot-rich" method.
// Self-contained: only imports from markdown.ts and Obsidian's API.

import { App, TFile, Notice, requestUrl } from "obsidian";
import { TelegramChannel, TelegramSettings } from "./types";
import { mdToBotApiHtml, obsidianToRichMarkdown, isRichEmbeddableUrl } from "./markdown";

// ─── Internal types ───────────────────────────────────────────────────────────

interface SendResult {
    link: string;
    messageId: number;
    commentLinks?: string[];
}

interface MediaFile {
    name: string;
    extension: string;
    getBlob: () => Promise<Blob>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "mkv", "webm"]);
const SUPPORTED_MEDIA_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "pdf", ...VIDEO_EXTS]);

// ─── Frontmatter extraction ───────────────────────────────────────────────────

function extractFrontmatter(content: string): { body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    return { body: match ? content.slice(match[0].length) : content };
}

// ─── Split helpers ────────────────────────────────────────────────────────────

function splitBodyByMarkers(body: string): string[] {
    const marker = /^[ \t]*(?:%%\s*\\split\s*%%|<!--\s*\\split\s*-->)[ \t]*$/gm;
    return body.split(marker).map(p => p.trim()).filter(p => p.length > 0);
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

function collectBotMedia(app: App, body: string, sourceFile: TFile): { attachments: MediaFile[]; mdEmbeds: TFile[] } {
    const wikilinkRegex = /!\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;
    const mdLinkRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
    const reverseMdLinkRegex = /!\(([^)]+)\)\[[^\]]*\]/g;

    const seen = new Set<string>();
    const attachments: MediaFile[] = [];
    const mdEmbeds: TFile[] = [];

    const processLinkpath = (rawPath: string) => {
        let cleanPath = rawPath.split(/\s+"/)[0].split(/[?#]/)[0].trim();

        if (/^https?:\/\//i.test(cleanPath)) {
            // Rich-embeddable HTTP(S) media (images/video/audio/gif) is carried inside
            // the Rich Markdown as a media block, so it must NOT also be uploaded here —
            // that would double-send it. Non-rich remote files (e.g. PDFs) still upload.
            if (isRichEmbeddableUrl(cleanPath)) return;
            if (!seen.has(cleanPath)) {
                seen.add(cleanPath);
                const ext = cleanPath.split('.').pop()?.toLowerCase() || "";
                if (SUPPORTED_MEDIA_EXTS.has(ext)) {
                    attachments.push({
                        name: cleanPath.split('/').pop() || `media.${ext}`,
                        extension: ext,
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
    // eslint-disable-next-line no-restricted-globals
    const response = await fetch(botUrl(token, method), { method: "POST", body: form });
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

// Prefers Rich Messages; falls back to a classic HTML message if sendRichMessage
// is unavailable for this bot (e.g. the Bot API server predates 10.1, or the bot
// lacks the capability). The fallback only fires before anything is sent, so there
// is no risk of a double post.
async function sendRichOrClassicText(token: string, chatId: string, markdown: string, html: string, silent: boolean, topicId?: number): Promise<SendResult> {
    if (markdown.length > 0) {
        try {
            return await sendRichTextBot(token, chatId, markdown, silent, topicId);
        } catch (err) {
            console.warn(
                "[publish-to-telegram] sendRichMessage failed, falling back to HTML sendMessage:",
                err instanceof Error ? err.message : err
            );
        }
    }
    return await sendTextBot(token, chatId, html, silent, topicId);
}

async function sendPhotoBot(token: string, chatId: string, file: MediaFile, caption: string, silent: boolean, attachUnderText: boolean, topicId?: number): Promise<SendResult> {
    const form = new FormData();
    Object.entries(baseBody(chatId, silent, topicId)).forEach(([k, v]) => form.append(k, String(v)));
    form.append("photo", await file.getBlob(), file.name);
    if (caption) { form.append("caption", caption); form.append("parse_mode", "HTML"); }
    if (attachUnderText) form.append("show_caption_above_media", "true");
    const result = await callBotFetch(token, "sendPhoto", form) as { chat: { id: number; username?: string }; message_id: number };
    return { link: buildBotPostLink(chatId, result.message_id), messageId: result.message_id };
}

async function sendVideoBot(token: string, chatId: string, file: MediaFile, caption: string, silent: boolean, attachUnderText: boolean, topicId?: number): Promise<SendResult> {
    const form = new FormData();
    Object.entries(baseBody(chatId, silent, topicId)).forEach(([k, v]) => form.append(k, String(v)));
    form.append("video", await file.getBlob(), file.name);
    if (caption) { form.append("caption", caption); form.append("parse_mode", "HTML"); }
    if (attachUnderText) form.append("show_caption_above_media", "true");
    const result = await callBotFetch(token, "sendVideo", form) as { chat: { id: number; username?: string }; message_id: number };
    return { link: buildBotPostLink(chatId, result.message_id), messageId: result.message_id };
}

async function sendAnimationBot(token: string, chatId: string, file: MediaFile, caption: string, silent: boolean, attachUnderText: boolean, topicId?: number): Promise<SendResult> {
    const form = new FormData();
    Object.entries(baseBody(chatId, silent, topicId)).forEach(([k, v]) => form.append(k, String(v)));
    form.append("animation", await file.getBlob(), file.name);
    if (caption) { form.append("caption", caption); form.append("parse_mode", "HTML"); }
    if (attachUnderText) form.append("show_caption_above_media", "true");
    const result = await callBotFetch(token, "sendAnimation", form) as { chat: { id: number; username?: string }; message_id: number };
    return { link: buildBotPostLink(chatId, result.message_id), messageId: result.message_id };
}

async function sendDocumentBot(token: string, chatId: string, file: MediaFile, caption: string, silent: boolean, attachUnderText: boolean, topicId?: number): Promise<SendResult> {
    const form = new FormData();
    Object.entries(baseBody(chatId, silent, topicId)).forEach(([k, v]) => form.append(k, String(v)));
    form.append("document", await file.getBlob(), file.name);
    if (caption) { form.append("caption", caption); form.append("parse_mode", "HTML"); }
    if (attachUnderText) form.append("show_caption_above_media", "true");
    const result = await callBotFetch(token, "sendDocument", form) as { chat: { id: number; username?: string }; message_id: number };
    return { link: buildBotPostLink(chatId, result.message_id), messageId: result.message_id };
}

async function sendMediaGroupBot(token: string, chatId: string, files: MediaFile[], caption: string, silent: boolean, attachUnderText: boolean, topicId?: number): Promise<SendResult> {
    const form = new FormData();
    Object.entries(baseBody(chatId, silent, topicId)).forEach(([k, v]) => form.append(k, String(v)));

    const mediaArray = await Promise.all(files.map(async (file, idx) => {
        const attachName = `file${idx}`;
        form.append(attachName, await file.getBlob(), file.name);
        const type = VIDEO_EXTS.has(file.extension) ? "video" : "photo";
        return {
            type,
            media: `attach://${attachName}`,
            ...(idx === 0 && caption ? { caption, parse_mode: "HTML", show_caption_above_media: attachUnderText } : {})
        };
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

// Sends a comment reply as a Rich Message when markdown is provided, falling back
// to a classic HTML reply if Rich Messages are unavailable. Passing an empty
// markdown string forces the classic path (used when the "rich comments" toggle is off).
// Returns the sent message's ID, or null if sending failed entirely.
async function sendRichOrClassicReply(token: string, chatId: string, replyToMessageId: number, markdown: string, html: string, silent: boolean, topicId?: number): Promise<number | null> {
    if (markdown.length > 0) {
        try {
            return await sendRichReplyBot(token, chatId, replyToMessageId, markdown, silent, topicId);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn("[publish-to-telegram] rich comment failed, falling back to HTML reply:", msg);
            new Notice(`Rich comment unavailable — sending as standard text. (${msg})`);
        }
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
    const { attachments, mdEmbeds } = collectBotMedia(app, body, sourceFile);

    const photoAndVideoFiles = attachments.filter(f =>
        ["jpg", "jpeg", "png", "webp"].includes(f.extension) || VIDEO_EXTS.has(f.extension)
    );
    const gifFiles = attachments.filter(f => f.extension === "gif");
    const docFiles = attachments.filter(f => f.extension === "pdf");

    // richMarkdown carries the post text AND any HTTP(S) media embeds (as rich media
    // blocks). uploadMedia is only the locally-stored / non-rich files that the Rich
    // Message API can't reference by URL and must be uploaded separately.
    const hasPostText = postMarkdown.length > 0 || htmlFallback.length > 0;
    const hasUploadMedia = photoAndVideoFiles.length > 0 || gifFiles.length > 0 || docFiles.length > 0;

    // Uploads the local / non-rich media files without captions; returns the first
    // message's SendResult.
    async function sendUploadMedia(): Promise<SendResult | null> {
        let mediaResult: SendResult | null = null;

        if (photoAndVideoFiles.length > 0) {
            const firstBatch = photoAndVideoFiles.slice(0, 10);
            const remaining = photoAndVideoFiles.slice(10);
            if (firstBatch.length === 1) {
                const f = firstBatch[0];
                mediaResult = VIDEO_EXTS.has(f.extension)
                    ? await sendVideoBot(token, chatId, f, "", silent, false, topicId)
                    : await sendPhotoBot(token, chatId, f, "", silent, false, topicId);
            } else {
                mediaResult = await sendMediaGroupBot(token, chatId, firstBatch, "", silent, false, topicId);
            }
            for (const f of remaining) {
                await (VIDEO_EXTS.has(f.extension)
                    ? sendVideoBot(token, chatId, f, "", silent, false, topicId)
                    : sendPhotoBot(token, chatId, f, "", silent, false, topicId));
            }
        }

        for (const gif of gifFiles) {
            const r = await sendAnimationBot(token, chatId, gif, "", silent, false, topicId);
            if (!mediaResult) mediaResult = r;
        }

        if (docFiles.length > 0) {
            const firstBatch = docFiles.slice(0, 10);
            const remainingDocs = docFiles.slice(10);
            const docResult = firstBatch.length === 1
                ? await sendDocumentBot(token, chatId, firstBatch[0], "", silent, false, topicId)
                : await sendMediaGroupBot(token, chatId, firstBatch, "", silent, false, topicId);
            if (!mediaResult) mediaResult = docResult;
            for (const doc of remainingDocs) await sendDocumentBot(token, chatId, doc, "", silent, false, topicId);
        }

        return mediaResult;
    }

    // Post text goes as a Rich Message ("bot + rich", postMarkdown set) or a classic
    // HTML message ("bot", postMarkdown empty). Local uploads are sent without captions
    // as separate messages. attachUnderText controls which comes first in the chat.
    let result: SendResult | null = null;

    if (!hasUploadMedia) {
        if (hasPostText) result = await sendRichOrClassicText(token, chatId, postMarkdown, htmlFallback, silent, topicId);
    } else if (!hasPostText) {
        result = await sendUploadMedia();
    } else if (attachUnderText) {
        // Text above media: send the text message first, then the uploads
        result = await sendRichOrClassicText(token, chatId, postMarkdown, htmlFallback, silent, topicId);
        await sendUploadMedia();
    } else {
        // Media above text (default): send the uploads first, then the text message
        result = await sendUploadMedia();
        await sendRichOrClassicText(token, chatId, postMarkdown, htmlFallback, silent, topicId);
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
                        if (commentMsgId !== null) commentLinks.push(buildBotPostLink(String(linkedChatId), commentMsgId));
                    } else {
                        new Notice("Couldn't find the discussion message to comment under.");
                    }
                } else {
                    const commentMsgId = await sendRichOrClassicReply(token, chatId, result.messageId, commentMd, commentHtml, silent, topicId);
                    if (commentMsgId !== null) commentLinks.push(buildBotPostLink(chatId, commentMsgId));
                }
            } catch (err) {
                new Notice(`Comment failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    return result ? { ...result, commentLinks } : null;
}

// ─── Edit helpers ─────────────────────────────────────────────────────────────

async function editMessageBot(token: string, chatId: string, messageId: number, text: string): Promise<void> {
    try {
        await callBotJson(token, "editMessageText", {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: "HTML",
        });
    } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
        if (msg.includes("there is no text in the message to edit")) {
            await callBotJson(token, "editMessageCaption", {
                chat_id: chatId,
                message_id: messageId,
                caption: text,
                parse_mode: "HTML",
            });
        } else {
            throw err;
        }
    }
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
): Promise<{ links: string[]; commentLinks: string[]; errors: Error[] }> {
    const token = channel.botToken ?? "";
    if (!token) throw new Error("Bot token is not configured for this preset.");

    const targets = channel.chatTargets?.length > 0
        ? channel.chatTargets
        : (channel.chatId ? [{ id: channel.chatId, title: channel.chatTitle }] : []);

    if (targets.length === 0) throw new Error("No chat targets configured for this preset.");

    const content = await app.vault.read(file);
    const { body } = extractFrontmatter(content);

    // ── Edit existing message ─────────────────────────────────────────────────

    if (updateLink && updateLink !== "none") {
        const msgIdMatch = updateLink.match(/\/(\d+)\/?$/);
        const messageId = msgIdMatch ? parseInt(msgIdMatch[1], 10) : null;
        if (messageId) {
            const htmlContent = mdToBotApiHtml(body);
            for (const target of targets) {
                const chatId = resolveChatId(target.id);
                await editMessageBot(token, chatId, messageId, htmlContent);
            }
            return { links: [updateLink], commentLinks: [], errors: [] };
        }
    }

    // ── Send all parts to all targets ─────────────────────────────────────────

    const parts = splitBodyByMarkers(body);
    const effectiveParts = parts.length > 0 ? parts : [body];

    const links: string[] = [];
    const commentLinks: string[] = [];
    const errors: Error[] = [];

    for (const target of targets) {
        const chatId = resolveChatId(target.id);
        const topicId = target.topicId;

        for (const part of effectiveParts) {
            try {
                const result = await sendPartViaBotApi(
                    app, part, token, chatId, silent, attachUnderText,
                    treatMdEmbedsAsComments, file, topicId, postAsRich, commentsAsRich,
                );
                if (result) {
                    links.push(result.link);
                    if (result.commentLinks?.length) commentLinks.push(...result.commentLinks);
                }
            } catch (err) {
                errors.push(err instanceof Error ? err : new Error(String(err)));
            }
        }
    }

    return { links, commentLinks, errors };
}
