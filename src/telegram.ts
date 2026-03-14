import { App, TFile } from "obsidian";
import { convert } from "telegram-markdown-v2";
import { TelegramChannel } from "./types";

// ─── Frontmatter extraction ───────────────────────────────────────────────────

function extractFrontmatter(content: string): { frontmatter: string; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    const body = match ? content.slice(match[0].length) : content;
    if (!match) return { frontmatter: "", body };
    return { frontmatter: match[1], body };
}

// ─── Content preparation ──────────────────────────────────────────────────────

function prepareContent(body: string): string {
    // Replace markdown HR rules (--- *** ___) with Unicode box-drawing characters
    const withHr = body.replace(/^(-{3,}|\*{3,}|_{3,})$/gm, (hr) => '\u2500'.repeat(hr.length));
    // Strip embedded wiki-links ![[]] before converting
    const stripped = withHr.replace(/!\[\[[^\]]*\]\]/g, "").replace(/[ \t]+\n/g, "\n").trim();

    // Convert via telegram-markdown-v2 library
    let result = convert(stripped);

    // The telegram-markdown-v2 library adds extra spaces after block markers
    // (quote sign, list bullets, numbered list markers). It looks ugly, so we normalize them.
    // Remove the extra space after the blockquote sign
    result = result.replace(/^> /gm, '>');
    // Replace +/• list markers with a bullet and a single space
    result = result.replace(/^(\s*)(?:\+|•)\s+/gm, '$1• ');
    // Normalize spaces after dot-style numbered list markers (e.g. "1\.")
    result = result.replace(/^(\s*\d+\\\.)\s+/gm, '$1 ');
    // Escape parenthesis-style numbered list markers and normalize spaces (e.g. "1)" → "1\)")
    result = result.replace(/^(\s*\d+)\)\s+/gm, '$1\\) ');
    return result;
}

// ─── Telegram API calls ───────────────────────────────────────────────────────

async function sendTextMessage(channel: TelegramChannel, text: string, silent: boolean) {
    const body: Record<string, unknown> = {
        chat_id: channel.chatId,
        text,
        parse_mode: "MarkdownV2",
    };
    if (silent) body.disable_notification = true;

    const response = await fetch(`https://api.telegram.org/bot${channel.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error((await response.json()).description);
}

async function sendSingleMedia(app: App, channel: TelegramChannel, file: TFile, type: "photo" | "document", caption: string, silent: boolean, attachUnderText: boolean) {
    const method = type === "photo" ? "sendPhoto" : "sendDocument";
    const formData = new FormData();
    formData.append("chat_id", channel.chatId);
    formData.append(type, new Blob([await app.vault.readBinary(file)]), file.name);
    if (caption) {
        formData.append("caption", caption);
        formData.append("parse_mode", "MarkdownV2");
    }
    if (silent) formData.append("disable_notification", "true");
    if (attachUnderText) formData.append("show_caption_above_media", "true");

    const response = await fetch(`https://api.telegram.org/bot${channel.botToken}/${method}`, { method: "POST", body: formData });
    if (!response.ok) throw new Error((await response.json()).description);
}

async function sendMediaGroup(app: App, channel: TelegramChannel, files: TFile[], type: "photo" | "document", caption: string, silent: boolean, attachUnderText: boolean) {
    const formData = new FormData();
    formData.append("chat_id", channel.chatId);
    if (silent) formData.append("disable_notification", "true");

    const mediaArray = await Promise.all(files.map(async (file, idx) => {
        const attachName = `file${idx}`;
        formData.append(attachName, new Blob([await app.vault.readBinary(file)]), file.name);
        return {
            type: type,
            media: `attach://${attachName}`,
            ...(idx === 0 && caption ? {
                caption,
                parse_mode: "MarkdownV2",
                show_caption_above_media: attachUnderText
            } : {})
        };
    }));

    formData.append("media", JSON.stringify(mediaArray));
    const response = await fetch(`https://api.telegram.org/bot${channel.botToken}/sendMediaGroup`, { method: "POST", body: formData });
    if (!response.ok) throw new Error((await response.json()).description);
}

function resolveChatId(value: string): string {
    const trimmed = value.trim();
    // If already starts with @ or is a number (including negative) — leave as is
    if (trimmed.startsWith("@") || /^-?\d+$/.test(trimmed)) return trimmed;
    // Otherwise assume it's a username without @ — add it
    return `@${trimmed}`;
}

export async function sendNoteToTelegram(app: App, file: TFile, tg_channel: TelegramChannel, silent: boolean, attachUnderText: boolean): Promise<void> {
	  const channel = { ...tg_channel, chatId: resolveChatId(tg_channel.chatId) };
    const content = await app.vault.read(file);
    const { body } = extractFrontmatter(content);
    const formattedContent = prepareContent(body);
    // Collect only files that are actually embedded in the note via ![[...]] syntax.
    // The link text may contain an alias or heading anchor (e.g. ![[image.png|caption]]
    // or ![[note#section]]), so we capture only the part before the first | or #.
    const embeddedLinkRegex = /!\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;
    const supportedExts = new Set(["jpg", "jpeg", "png", "gif", "webp", "pdf"]);
    const seen = new Set<string>();
    const attachments: TFile[] = [];
    let m: RegExpExecArray | null;
    while ((m = embeddedLinkRegex.exec(body)) !== null) {
        const linkpath = m[1].trim();
        const resolved = app.metadataCache.getFirstLinkpathDest(linkpath, file.path);
        if (resolved instanceof TFile && supportedExts.has(resolved.extension) && !seen.has(resolved.path)) {
            seen.add(resolved.path);
            attachments.push(resolved);
        }
    }

    const photoFiles = attachments.filter(f => ["jpg", "jpeg", "png", "gif", "webp"].includes(f.extension));
    const docFiles = attachments.filter(f => f.extension === "pdf");

    if (photoFiles.length > 0) {
        const firstBatch = photoFiles.slice(0, 10);
        const remainingPhotos = photoFiles.slice(10);
        if (firstBatch.length === 1) {
            await sendSingleMedia(app, channel, firstBatch[0], "photo", formattedContent, silent, attachUnderText);
        } else {
            await sendMediaGroup(app, channel, firstBatch, "photo", formattedContent, silent, attachUnderText);
        }
        for (const photo of remainingPhotos) await sendSingleMedia(app, channel, photo, "photo", "", silent, false);
    }
    else if (docFiles.length > 0) {
        const firstBatch = docFiles.slice(0, 10);
        const remainingDocs = docFiles.slice(10);
        if (firstBatch.length === 1) {
            await sendSingleMedia(app, channel, firstBatch[0], "document", formattedContent, silent, attachUnderText);
        } else {
            await sendMediaGroup(app, channel, firstBatch, "document", formattedContent, silent, attachUnderText);
        }
        for (const doc of remainingDocs) await sendSingleMedia(app, channel, doc, "document", "", silent, false);
    }
    else if (formattedContent.length > 0) {
        await sendTextMessage(channel, formattedContent, silent);
    }
}