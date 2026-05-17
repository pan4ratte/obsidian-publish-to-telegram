import { App, TFile, requestUrl } from "obsidian";
import { convert } from "telegram-markdown-v2";
import { TelegramChannel } from "./types";

// ─── Constants ────────────────────────────────────────────────────────────────

export const CHAR_LIMIT = 4096;
const MEDIA_BATCH_MAX = 10;
const DISCUSSION_POLL_MAX = 5;
const DISCUSSION_POLL_DELAY_MS = 1500;
const VIDEO_EXTS = new Set(["mp4", "mov", "avi", "mkv", "webm"]);

// ─── Internal types ───────────────────────────────────────────────────────────

type ChannelWithToken = TelegramChannel & { botToken: string };

interface SendResult {
    link: string;
    messageId: number;
}

interface MediaFile {
    name: string;
    extension: string;
    getBlob: () => Promise<Blob>;
}

// ─── Telegram API helpers ─────────────────────────────────────────────────────

async function tgPostJson<T>(botToken: string, method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.description);
    return data as T;
}

async function tgPostForm<T>(botToken: string, method: string, body: FormData): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: "POST",
        body,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.description);
    return data as T;
}

// ─── Media type helpers ───────────────────────────────────────────────────────

function mediaGroupType(extension: string): "photo" | "video" {
    return VIDEO_EXTS.has(extension) ? "video" : "photo";
}

// ─── Content processing pipeline ──────────────────────────────────────────────

export function extractFrontmatter(content: string): { frontmatter: string; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) return { frontmatter: "", body: content };
    return { frontmatter: match[1], body: content.slice(match[0].length) };
}

export function extractMarkerContent(body: string, startMarker: string, endMarker: string): string {
    if (!startMarker || !endMarker) return body;
    const startIdx = body.indexOf(startMarker);
    const endIdx = body.indexOf(endMarker, startIdx !== -1 ? startIdx + startMarker.length : 0);
    if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
        return body.slice(startIdx + startMarker.length, endIdx);
    }
    if (startIdx !== -1 && endIdx === -1) {
        return body.slice(startIdx + startMarker.length);
    }
    if (startIdx === -1 && endIdx !== -1) {
        return body.slice(0, endIdx);
    }
    return body;
}

export function prepareContent(body: string): string {
    const withHr = body.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, (hr) => '\u2500'.repeat(hr.length));
    const stripped = withHr
        .replace(/%%[\s\S]*?%%/g, "")
        .replace(/!\[\[[^\]]*\]\]/g, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/!\([^)]*\)\[[^\]]*\]/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .trim();

    let result = convert(stripped);
    result = result.replace(/^> /gm, '>');
    result = result.replace(/^(\s*)(?:\+|•)\s+/gm, '$1• ');
    result = result.replace(/^(\s*\d+\\\.)\s+/gm, '$1 ');
    result = result.replace(/^(\s*\d+)\)\s+/gm, '$1\\) ');
    return result;
}

export async function prepareNoteContent(app: App, file: TFile, startMarker: string, endMarker: string): Promise<string> {
    const content = await app.vault.read(file);
    const { body } = extractFrontmatter(content);
    const textToProcess = extractMarkerContent(body, startMarker, endMarker);
    return prepareContent(textToProcess);
}

// ─── Telegram API methods ─────────────────────────────────────────────────────

function buildPostLink(chat: { id: number; username?: string }, messageId: number): string {
    if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
    const channelId = String(chat.id).replace(/^-100/, "");
    return `https://t.me/c/${channelId}/${messageId}`;
}

async function getLinkedChatId(channel: ChannelWithToken): Promise<number | null> {
    const data = await tgPostJson<any>(channel.botToken, "getChat", { chat_id: channel.chatId });
    return data.result.linked_chat_id ?? null;
}

async function findDiscussionMessageId(botToken: string, linkedChatId: number, channelMessageId: number): Promise<number | null> {
    for (let attempt = 0; attempt < DISCUSSION_POLL_MAX; attempt++) {
        await new Promise(resolve => setTimeout(resolve, DISCUSSION_POLL_DELAY_MS));
        try {
            const data = await tgPostJson<any>(botToken, "getUpdates", {
                limit: 100, allowed_updates: ["message"],
            });
            for (const update of [...data.result].reverse()) {
                const msg = update.message;
                if (!msg || msg.chat.id !== linkedChatId) continue;
                const forwardedFromId = msg.forward_origin?.message_id ?? msg.forward_from_message_id;
                if (forwardedFromId === channelMessageId) return msg.message_id;
            }
        } catch { continue; }
    }
    return null;
}

async function sendTextMessage(channel: ChannelWithToken, text: string, silent: boolean): Promise<SendResult> {
    const body: Record<string, unknown> = { chat_id: channel.chatId, text, parse_mode: "MarkdownV2" };
    if (silent) body.disable_notification = true;
    const data = await tgPostJson<any>(channel.botToken, "sendMessage", body);
    return { link: buildPostLink(data.result.chat, data.result.message_id), messageId: data.result.message_id };
}

async function sendReply(botToken: string, chatId: number | string, replyToMessageId: number, text: string, silent: boolean): Promise<void> {
    const body: Record<string, unknown> = {
        chat_id: chatId, reply_to_message_id: replyToMessageId, text, parse_mode: "MarkdownV2",
    };
    if (silent) body.disable_notification = true;
    await tgPostJson<any>(botToken, "sendMessage", body);
}

async function sendSinglePhoto(app: App, channel: ChannelWithToken, file: MediaFile, caption: string, silent: boolean, attachUnderText: boolean): Promise<SendResult> {
    const formData = new FormData();
    formData.append("chat_id", channel.chatId);
    formData.append("photo", await file.getBlob(), file.name);
    if (caption) { formData.append("caption", caption); formData.append("parse_mode", "MarkdownV2"); }
    if (silent) formData.append("disable_notification", "true");
    if (attachUnderText) formData.append("show_caption_above_media", "true");
    const data = await tgPostForm<any>(channel.botToken, "sendPhoto", formData);
    return { link: buildPostLink(data.result.chat, data.result.message_id), messageId: data.result.message_id };
}

async function sendAnimation(app: App, channel: ChannelWithToken, file: MediaFile, caption: string, silent: boolean, attachUnderText: boolean): Promise<SendResult> {
    const formData = new FormData();
    formData.append("chat_id", channel.chatId);
    formData.append("animation", await file.getBlob(), file.name);
    if (caption) { formData.append("caption", caption); formData.append("parse_mode", "MarkdownV2"); }
    if (silent) formData.append("disable_notification", "true");
    if (attachUnderText) formData.append("show_caption_above_media", "true");
    const data = await tgPostForm<any>(channel.botToken, "sendAnimation", formData);
    return { link: buildPostLink(data.result.chat, data.result.message_id), messageId: data.result.message_id };
}

async function sendSingleVideo(app: App, channel: ChannelWithToken, file: MediaFile, caption: string, silent: boolean, attachUnderText: boolean): Promise<SendResult> {
    const formData = new FormData();
    formData.append("chat_id", channel.chatId);
    formData.append("video", await file.getBlob(), file.name);
    if (caption) { formData.append("caption", caption); formData.append("parse_mode", "MarkdownV2"); }
    if (silent) formData.append("disable_notification", "true");
    if (attachUnderText) formData.append("show_caption_above_media", "true");
    const data = await tgPostForm<any>(channel.botToken, "sendVideo", formData);
    return { link: buildPostLink(data.result.chat, data.result.message_id), messageId: data.result.message_id };
}

async function sendSingleDocument(app: App, channel: ChannelWithToken, file: MediaFile, caption: string, silent: boolean, attachUnderText: boolean): Promise<SendResult> {
    const formData = new FormData();
    formData.append("chat_id", channel.chatId);
    formData.append("document", await file.getBlob(), file.name);
    if (caption) { formData.append("caption", caption); formData.append("parse_mode", "MarkdownV2"); }
    if (silent) formData.append("disable_notification", "true");
    if (attachUnderText) formData.append("show_caption_above_media", "true");
    const data = await tgPostForm<any>(channel.botToken, "sendDocument", formData);
    return { link: buildPostLink(data.result.chat, data.result.message_id), messageId: data.result.message_id };
}

async function sendMediaGroup(app: App, channel: ChannelWithToken, files: MediaFile[], caption: string, silent: boolean, attachUnderText: boolean): Promise<SendResult> {
    const formData = new FormData();
    formData.append("chat_id", channel.chatId);
    if (silent) formData.append("disable_notification", "true");

    const mediaArray = await Promise.all(files.map(async (file, idx) => {
        const attachName = `file${idx}`;
        formData.append(attachName, await file.getBlob(), file.name);
        return {
            type: mediaGroupType(file.extension),
            media: `attach://${attachName}`,
            ...(idx === 0 && caption ? { caption, parse_mode: "MarkdownV2", show_caption_above_media: attachUnderText } : {}),
        };
    }));

    formData.append("media", JSON.stringify(mediaArray));
    const data = await tgPostForm<any>(channel.botToken, "sendMediaGroup", formData);
    return { link: buildPostLink(data.result[0].chat, data.result[0].message_id), messageId: data.result[0].message_id };
}

function resolveChatId(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith("@") || /^-?\d+$/.test(trimmed)) return trimmed;
    return `@${trimmed}`;
}

// ── Finds a configured channel that matches the provided Telegram link

export function findChannelByLink(channels: TelegramChannel[], link: string): TelegramChannel | null {
    const msgIdMatch = link.match(/\/(?:t\.me\/|c\/|)([^/]+)\/(\d+)\/?$/);
    if (!msgIdMatch) return null;
    const identifier = msgIdMatch[1];
    return channels.find(c => {
        const cleanChatId = c.chatId.replace(/^-100|^@/, "");
        return c.chatId === identifier || c.chatId === `@${identifier}` || cleanChatId === identifier;
    }) || null;
}

export async function sendNoteToTelegram(
    app: App, file: TFile, tg_channel: TelegramChannel,
    silent: boolean, attachUnderText: boolean, treatMdEmbedsAsComments: boolean,
    updateLink?: string, startMarker: string = "", endMarker: string = "",
    botToken: string = "", preFormattedContent?: string,
): Promise<string | null> {
    const channel: ChannelWithToken = { ...tg_channel, chatId: resolveChatId(tg_channel.chatId), botToken };

    const formattedContent = preFormattedContent ?? await prepareNoteContent(app, file, startMarker, endMarker);

    // ── Update Existing Post ──────────────────────────────────────────────────

    if (updateLink && updateLink !== "none") {
        const msgIdMatch = updateLink.match(/\/(\d+)\/?$/);
        const messageId = msgIdMatch ? parseInt(msgIdMatch[1], 10) : null;

        if (messageId) {
            try {
                await tgPostJson<any>(channel.botToken, "editMessageText", {
                    chat_id: channel.chatId, message_id: messageId, text: formattedContent, parse_mode: "MarkdownV2",
                });
            } catch (err: any) {
                if (err.message?.includes("there is no text in the message to edit")) {
                    await tgPostJson<any>(channel.botToken, "editMessageCaption", {
                        chat_id: channel.chatId, message_id: messageId, caption: formattedContent, parse_mode: "MarkdownV2",
                    });
                } else {
                    throw err;
                }
            }
            return updateLink;
        }
    }

    // ── Send New Post ─────────────────────────────────────────────────────────

    const wikilinkRegex = /!\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;
    const mdLinkRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
    const reverseMdLinkRegex = /!\(([^)]+)\)\[[^\]]*\]/g;

    const supportedMediaExts = new Set(["jpg", "jpeg", "png", "gif", "webp", "pdf", ...VIDEO_EXTS]);
    const seen = new Set<string>();
    const attachments: MediaFile[] = [];
    const mdEmbeds: TFile[] = [];

    const processLinkpath = (rawPath: string) => {
        let cleanPath = rawPath.split(/\s+"/)[0].split(/[?#]/)[0].trim();

        if (/^https?:\/\//i.test(cleanPath)) {
            if (!seen.has(cleanPath)) {
                seen.add(cleanPath);
                const ext = cleanPath.split('.').pop()?.toLowerCase() || "";
                if (supportedMediaExts.has(ext)) {
                    attachments.push({
                        name: cleanPath.split('/').pop() || `media.${ext}`,
                        extension: ext,
                        getBlob: async () => new Blob([(await requestUrl({ url: cleanPath })).arrayBuffer]),
                    });
                }
            }
            return;
        }

        try { cleanPath = decodeURIComponent(cleanPath); } catch (e) {}

        const resolved = app.metadataCache.getFirstLinkpathDest(cleanPath, file.path);
        if (resolved instanceof TFile && !seen.has(resolved.path)) {
            seen.add(resolved.path);
            if (supportedMediaExts.has(resolved.extension)) {
                attachments.push({
                    name: resolved.name,
                    extension: resolved.extension,
                    getBlob: async () => new Blob([await app.vault.readBinary(resolved)]),
                });
            } else if (resolved.extension === "md") {
                mdEmbeds.push(resolved);
            }
        }
    };

    const body = (await app.vault.read(file)).replace(/^---[\s\S]*?---\r?\n?/, "");

    let m: RegExpExecArray | null;
    while ((m = wikilinkRegex.exec(body)) !== null) processLinkpath(m[1]);
    while ((m = mdLinkRegex.exec(body)) !== null) processLinkpath(m[1]);
    while ((m = reverseMdLinkRegex.exec(body)) !== null) processLinkpath(m[1]);

    const photoAndVideoFiles = attachments.filter(f =>
        ["jpg", "jpeg", "png", "webp"].includes(f.extension) || VIDEO_EXTS.has(f.extension)
    );
    const gifFiles = attachments.filter(f => f.extension === "gif");
    const docFiles = attachments.filter(f => f.extension === "pdf");

    let result: SendResult | null = null;
    let captionConsumed = false;

    if (photoAndVideoFiles.length > 0) {
        const firstBatch = photoAndVideoFiles.slice(0, MEDIA_BATCH_MAX);
        const remaining = photoAndVideoFiles.slice(MEDIA_BATCH_MAX);

        if (firstBatch.length === 1) {
            const f = firstBatch[0];
            result = VIDEO_EXTS.has(f.extension)
                ? await sendSingleVideo(app, channel, f, formattedContent, silent, attachUnderText)
                : await sendSinglePhoto(app, channel, f, formattedContent, silent, attachUnderText);
        } else {
            result = await sendMediaGroup(app, channel, firstBatch, formattedContent, silent, attachUnderText);
        }
        captionConsumed = true;

        for (const f of remaining) {
            await (VIDEO_EXTS.has(f.extension) ? sendSingleVideo(app, channel, f, "", silent, false)
                : sendSinglePhoto(app, channel, f, "", silent, false));
        }
    }

    for (const gif of gifFiles) {
        const gifResult = await sendAnimation(app, channel, gif, captionConsumed ? "" : formattedContent, silent, attachUnderText);
        if (!result) result = gifResult;
        captionConsumed = true;
    }

    if (docFiles.length > 0) {
        const firstBatch = docFiles.slice(0, MEDIA_BATCH_MAX);
        const remainingDocs = docFiles.slice(MEDIA_BATCH_MAX);
        const docResult = firstBatch.length === 1
            ? await sendSingleDocument(app, channel, firstBatch[0], captionConsumed ? "" : formattedContent, silent, attachUnderText)
            : await sendMediaGroup(app, channel, firstBatch, captionConsumed ? "" : formattedContent, silent, attachUnderText);
        if (!result) result = docResult;
        captionConsumed = true;
        for (const doc of remainingDocs) await sendSingleDocument(app, channel, doc, "", silent, false);
    }

    if (!result && formattedContent.length > 0) {
        result = await sendTextMessage(channel, formattedContent, silent);
    }

    // ── Send .md embeds as comments ───────────────────────────────────────────

    if (treatMdEmbedsAsComments && result && mdEmbeds.length > 0) {
        const linkedChatId = await getLinkedChatId(channel);

        for (const mdFile of mdEmbeds) {
            const mdContent = await app.vault.read(mdFile);
            const { body: mdBody } = extractFrontmatter(mdContent);
            const formattedMdContent = prepareContent(mdBody);
            if (!formattedMdContent) continue;

            if (linkedChatId !== null) {
                const discussionMessageId = await findDiscussionMessageId(channel.botToken, linkedChatId, result.messageId);
                if (discussionMessageId !== null) {
                    await sendReply(channel.botToken, linkedChatId, discussionMessageId, formattedMdContent, silent);
                }
            } else {
                await sendReply(channel.botToken, channel.chatId, result.messageId, formattedMdContent, silent);
            }
        }
    }

    return result ? result.link : null;
}
