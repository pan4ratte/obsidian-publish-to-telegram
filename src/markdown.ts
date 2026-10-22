// markdown.ts
// Obsidian-markdown → Telegram-HTML conversion.

// ─── Content preparation ──────────────────────────────────────────────────────

// Extensions that Telegram Rich Markdown renders as inline media blocks
// (photos, videos, audio, animations). Allows an optional ?query / #fragment.
const RICH_MEDIA_EXT = /\.(?:jpe?g|png|webp|gif|mp4|mov|mkv|webm|avi|mp3|ogg|m4a|wav|flac)(?:[?#][^)\s]*)?$/i;

// True when a standard-embed target is an HTTP(S) URL that Rich Markdown can render
// inline as a media block. Such embeds are kept in the Rich Markdown (so they ride
// along in the rich message) instead of being uploaded as separate files.
export function isRichEmbeddableUrl(rawTarget: string): boolean {
    const url = rawTarget.split(/\s+["']/)[0].trim();   // drop optional "title"/'title'
    return /^https?:\/\//i.test(url) && RICH_MEDIA_EXT.test(url);
}

// True for a `tg://photo|video|audio|document?id=…` reference to an uploaded rich-message
// attachment (see telegram.ts collectRichMedia). Such embeds are kept in the Rich Markdown
// so Telegram renders the uploaded local file inline, just like a web media URL.
export function isRichAttachmentRef(rawTarget: string): boolean {
    const url = rawTarget.split(/\s+["']/)[0].trim();
    return /^tg:\/\/(?:photo|video|audio|document)\?id=/i.test(url);
}

// Removes %% … %% and <!-- … --> comment regions (and any orphaned <!-- opener). Callers
// that must keep comment-like text inside code go through stripCommentsPreservingCode.
//
// The removal runs to a fixpoint: a single pass can let the text on either side of a removed
// comment recombine into a fresh `<!--`/`%%` (e.g. `<!--a-->b<!--` or nested comments), so we
// repeat until the string stops changing. Without this the sanitization is incomplete —
// commented content could survive, and a leftover `<!--` opener could leak into the output.
function removeCommentRegions(text: string): string {
    let previous: string;
    do {
        previous = text;
        text = text
            .replace(/%%[\s\S]*?%%/g, "")          // Obsidian comments %% ... %%
            .replace(/<!--[\s\S]*?-->/g, "");       // HTML comments
    } while (text !== previous);
    return text.replace(/<!--/g, "");              // any unclosed comment opener that remains
}

// Strips comments, but leaves comment-like text inside fenced or inline code untouched —
// there `%% … %%` / `<!-- … -->` is example content meant to be shown verbatim, not a comment.
// Code spans are stashed before the comment pass and restored after.
function stripCommentsPreservingCode(text: string): string {
    const stashed: string[] = [];
    const stash = (s: string): string => `\x00CM${stashed.push(s) - 1}\x00`;
    const protectedText = text
        .replace(/```[\s\S]*?```/g, stash)   // fenced code blocks
        .replace(/`[^`\n]+`/g, stash);       // inline code spans
    const stripped = removeCommentRegions(protectedText);
    // eslint-disable-next-line no-control-regex -- \x00 sentinels delimit stashed code spans
    return stripped.replace(/\x00CM(\d+)\x00/g, (_, i: string) => stashed[parseInt(i)]);
}

// keepRichMediaEmbeds: when true (Rich Markdown path), HTTP(S) media embeds are
// preserved so Telegram renders them as media blocks. The GramJS HTML path leaves
// it false because that parser can't express URL media blocks.
export function stripObsidianSyntax(body: string, opts: { keepRichMediaEmbeds?: boolean } = {}): string {
    return removeButtonBlocks(stripCommentsPreservingCode(body))   // comments (but keep those inside code), then buttons
        .replace(/!\[\[[^\]]*\]\]/g, "")           // Strip wikilink embeds (always local)
        .replace(/!\[[^\]]*\]\(([^)]*)\)/g, (match, target: string) =>
            opts.keepRichMediaEmbeds && (isRichEmbeddableUrl(target) || isRichAttachmentRef(target)) ? match : "")
        .replace(/!\([^)]*\)\[[^\]]*\]/g, "")      // Strip reversed MD embeds !()[]
        .replace(/[ \t]+\n/g, "\n")
        .trim();
}

// Removes only commented-out regions (%% … %% and <!-- … -->), leaving all other content —
// including embeds and links — intact. Media/embed collection runs on this so an attachment
// or pre-written comment (embedded note) the user commented out is not posted, mirroring how
// the text conversion (stripObsidianSyntax) already drops commented-out text. Not code-aware:
// media collection works on raw embed syntax, where a commented example embed inside a code
// block should still be excluded from the actual attachments.
export function stripComments(body: string): string {
    return removeCommentRegions(body);
}

// ─── Inline buttons ───────────────────────────────────────────────────────────

// Buttons under a post are written as a `tg-buttons` code block: one line per row, one
// <button> element per button, its attributes being Telegram's button properties.
//
//   ```tg-buttons
//   <button href="https://example.com" color="green">Website</button> <button copy="PROMO">Copy code</button>
//   <button href="https://t.me/example" emoji="5368324170671202286">Channel</button>
//   <button disabled>Sold out</button>
//   ```
//
// A code block rather than raw HTML because Obsidian's sanitizer strips unknown elements and
// their attributes, while a code block processor (src/buttons.ts) renders the same way in the
// editor, reading view and the publishing preview. The block is never part of the message text
// (stripObsidianSyntax removes it); the send paths read it separately (parseButtons). Bots send
// it as reply_markup; "account-rich" appends it to the message as `<tg-button-row>` blocks
// (buttonsToRichMarkdown), since only bots can attach reply_markup. Classic account posts
// can't have buttons.

// Telegram's button styles. `color` takes these or the colour each one is drawn in.
export type ButtonColor = "danger" | "success" | "primary";
const BUTTON_COLORS: Record<string, ButtonColor> = {
    red: "danger", danger: "danger",
    green: "success", success: "success",
    blue: "primary", primary: "primary",
};

// One button. Exactly one action is sent: `disabled`, else `url`, else `copy`; a button with
// none of them is refused on publish (BUTTON_NO_ACTION).
export interface InlineButton {
    text: string;
    url?: string;
    copy?: string;
    disabled?: boolean;
    color?: ButtonColor;
    emojiId?: string;
    // The emoji the picker wrote as the custom emoji's stand-in, when `emoji` was given in the
    // picker's own `[👍](tg://emoji?id=…)` form.
    emojiFallback?: string;
}

// A `tg-buttons` code block, fence included: the closing fence repeats the opening one.
const BUTTON_BLOCK = /^[ \t]*(`{3,}|~{3,})[ \t]*tg-buttons[ \t]*\n([\s\S]*?)^[ \t]*\1[ \t]*$\n?/gm;
const BUTTON_TAG = /<button\b([^>]*)>([\s\S]*?)<\/button\s*>/gi;
const BUTTON_ATTR = /([a-zA-Z][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function decodeEntities(text: string): string {
    return text
        .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 10)))
        .replace(/&#x([\da-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&");
}

// A button label is plain text, so any tags inside it are dropped. One pass already takes
// everything from a `<` to the next `>`; it's repeated until nothing changes because that's
// the form code scanning accepts as complete sanitising. The label is never used as HTML
// either way: it's rendered as text and escaped for Rich messages.
function stripTags(html: string): string {
    let previous: string;
    do {
        previous = html;
        html = html.replace(/<[^>]*>/g, "");
    } while (html !== previous);
    return html;
}

function parseButton(attrText: string, inner: string): InlineButton {
    const attrs = new Map<string, string>();
    for (const m of attrText.matchAll(BUTTON_ATTR)) {
        attrs.set(m[1].toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
    }
    const button: InlineButton = { text: decodeEntities(stripTags(inner).trim()) };
    if (attrs.has("disabled")) button.disabled = true;
    const href = attrs.get("href")?.trim();
    if (href) button.url = href;
    const copy = attrs.get("copy");
    if (copy) button.copy = copy;
    const color = BUTTON_COLORS[attrs.get("color")?.trim().toLowerCase() ?? ""];
    if (color) button.color = color;
    // An id, or the picker's `[👍](tg://emoji?id=…)` pasted in whole.
    const emoji = attrs.get("emoji") ?? "";
    const emojiId = /(\d{5,})/.exec(emoji)?.[1];
    if (emojiId) {
        button.emojiId = emojiId;
        const fallback = /^\s*\[([^\]]+)\]/.exec(emoji)?.[1];
        if (fallback) button.emojiFallback = fallback;
    }
    return button;
}

// The rows one `tg-buttons` block's content describes: each line holding at least one
// <button> is a row. Used both to send the block and to render it.
export function parseButtonRows(source: string): InlineButton[][] {
    const rows: InlineButton[][] = [];
    for (const line of source.split("\n")) {
        const row = Array.from(line.matchAll(BUTTON_TAG), m => parseButton(m[1], m[2]));
        if (row.length > 0) rows.push(row);
    }
    return rows;
}

// Removes every `tg-buttons` block from the text.
export function removeButtonBlocks(body: string): string {
    return body.replace(BUTTON_BLOCK, "");
}

// The button rows of every `tg-buttons` block in a post, in order. Commented-out blocks are
// skipped.
export function parseButtons(body: string): InlineButton[][] {
    return Array.from(stripComments(body).matchAll(BUTTON_BLOCK), m => parseButtonRows(m[2])).flat();
}

function escAttr(s: string): string {
    return escHtml(s).replace(/"/g, "&quot;");
}

// A post's buttons as Rich Markdown, or "" when it has none: one `<tg-button-row>` per row,
// which Telegram's server-side parser turns into button blocks. This is how an account posts
// buttons — the User API keeps reply_markup for bots, but a Rich Message may hold button
// blocks. Exactly one action per button, as on the bot path; one with none is refused.
export function buttonsToRichMarkdown(rows: InlineButton[][]): string {
    return rows.map(row => {
        const buttons = row.map(button => {
            let attrs: string;
            if (button.disabled) attrs = `type="disabled"`;
            else if (button.url) attrs = `type="url" url="${escAttr(button.url)}"`;
            else if (button.copy) attrs = `type="copy_text" text="${escAttr(button.copy)}"`;
            else throw new Error("BUTTON_NO_ACTION");
            if (button.color) attrs += ` style="${button.color}"`;
            const emoji = button.emojiId
                ? `<tg-emoji emoji-id="${button.emojiId}">${escHtml(button.emojiFallback ?? "")}</tg-emoji>`
                : "";
            const label = [emoji, escHtml(button.text)].filter(Boolean).join(" ");
            return `  <tg-button ${attrs}>${label}</tg-button>`;
        });
        return `<tg-button-row>\n${buttons.join("\n")}\n</tg-button-row>`;
    }).join("\n");
}

// ─── Rich-message attachments ─────────────────────────────────────────────────

// The rich-message reference kind (tg://<kind>?id=…) for a file extension. GIFs ride as
// videos (animations); any other file (PDF, .docx, .zip, an embedded note…) is a document
// (tg://document, Bot API 10.3).
export type RichKind = "photo" | "video" | "audio" | "document";
const RICH_PHOTO_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);
const RICH_VIDEO_EXTS = new Set(["mp4", "mov", "avi", "mkv", "webm", "gif"]);
const RICH_AUDIO_EXTS = new Set(["mp3", "ogg", "m4a", "wav", "flac"]);
export function richKindForExt(ext: string): RichKind {
    if (RICH_PHOTO_EXTS.has(ext)) return "photo";
    if (RICH_VIDEO_EXTS.has(ext)) return "video";
    if (RICH_AUDIO_EXTS.has(ext)) return "audio";
    return "document";
}

// Drops commented-out regions, then offers every embed's target (the path or URL, before any
// "title") to `replace`. A string return replaces the whole embed; null leaves it as written.
// Shared by the account and bot rich paths, which turn local embeds into tg://…?id= references.
export function rewriteEmbeds(body: string, replace: (target: string) => string | null): string {
    return stripComments(body)
        .replace(/!\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g, (m, p: string) => replace(p) ?? m)
        .replace(/!\[[^\]]*\]\(([^)]+)\)/g, (m, p: string) => replace(p) ?? m)
        .replace(/!\(([^)]+)\)\[[^\]]*\]/g, (m, p: string) => replace(p) ?? m);
}

export function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Custom emoji ─────────────────────────────────────────────────────────────

// A custom emoji as the picker writes it into a note: `[👍](tg://emoji?id=5368…)`, i.e. a
// plain markdown link whose text is the fallback emoji (so the note still reads correctly
// in Obsidian) and whose target carries the custom emoji's document id.
const CUSTOM_EMOJI_REF = /\[([^\]]+)\]\(tg:\/\/emoji\?id=(\d+)\)/g;

// A fresh matcher for callers that scan text themselves (the editor renderers), so nobody
// shares this module's `lastIndex`.
export function customEmojiRefRegex(): RegExp {
    return new RegExp(CUSTOM_EMOJI_REF.source, "g");
}

// Writes that reference (used by the emoji picker when inserting a custom emoji).
export function customEmojiRef(alt: string, id: string): string {
    return `[${alt}](tg://emoji?id=${id})`;
}

// Reads one back, for a string that is nothing but a reference — the form the picker
// stores in its recents.
export function parseCustomEmojiRef(text: string): { alt: string; id: string } | null {
    const match = new RegExp(`^${CUSTOM_EMOJI_REF.source}$`).exec(text);
    return match ? { alt: match[1], id: match[2] } : null;
}

// True when the note carries at least one custom emoji reference.
export function hasCustomEmoji(body: string): boolean {
    return new RegExp(CUSTOM_EMOJI_REF.source).test(body);
}

// Rewrites those references into Telegram's custom-emoji tag. One form serves every
// publishing path: mtcute's HTML parser (account posts), the Bot API's HTML parse mode and
// Rich Messages all understand `<tg-emoji emoji-id="…">fallback</tg-emoji>`.
export function customEmojiToHtml(text: string): string {
    return text.replace(CUSTOM_EMOJI_REF, (_, alt: string, id: string) =>
        `<tg-emoji emoji-id="${id}">${escHtml(alt)}</tg-emoji>`);
}

// Converts Obsidian markdown to Telegram "Rich Markdown" (Bot API 10.1).
//
// Rich Markdown is GitHub-Flavored-Markdown-compatible, so unlike mdToTelegramHtml
// (which downgrades headings → bold, lists → bullets, and drops tables) we pass the
// note's markdown through almost verbatim. Only Obsidian-specific syntax that Rich
// Markdown wouldn't understand is cleaned up:
//   - comments / embeds are stripped (reusing stripObsidianSyntax)
//   - remaining [[wikilinks]] are flattened to their display text
// Everything else — headings, tables, task lists, fenced code, blockquotes,
// ==highlight==, ||spoiler||, $math$, footnotes — is valid Rich Markdown as-is.
//
// HTTP(S) image/video/audio embeds are kept (keepRichMediaEmbeds) so Telegram renders
// them inline as media blocks, as are `tg://…?id=` references to uploaded attachments
// (telegram.ts rewrites local media embeds into these before calling this). Any remaining
// local embed (e.g. an embedded note) can't be a media block and is stripped.
//
// A Rich Message can hold empty lines, which Markdown's own block separation would otherwise
// swallow, so blank lines past the paragraph break the first one makes come back as real empty
// lines (materializeBlankLines).
export function obsidianToRichMarkdown(body: string): string {
    let text = stripObsidianSyntax(body, { keepRichMediaEmbeds: true });

    // [[target]], [[target|alias]], [[target#heading]], [[target#heading|alias]] → alias ?? target
    text = text.replace(
        /\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|([^[\]]+))?\]\]/g,
        (_, target: string, alias?: string) => (alias ?? target).trim()
    );

    // Custom emoji: Rich Messages take the same tag as the classic paths (it's one of the
    // documented rich-text tags), so a picked custom emoji survives every method.
    text = customEmojiToHtml(text);

    text = escapeRichHashtags(text);

    return materializeBlankLines(text.trim());
}

// The character that carries an otherwise empty line: a non-breaking space (U+00A0).
// See materializeBlankLines.
const BLANK_LINE_FILLER = "\u00A0";

// A line holding a single lone HTML tag, which opens or closes a container block
// (<tg-collage>, <tg-slideshow>, <details>, …). Their contents aren't free text — a media
// block list, a summary — so nothing is injected inside one.
const CONTAINER_TAG_LINE = /^[ \t]*<\/?[a-z][^>]*>[ \t]*$/i;

// Telegram's Rich Markdown reads blank lines the way any Markdown does — as block separators,
// not as content — and renders the blocks flush against each other, so an empty line a note is
// written with never shows up in the message on its own.
//
// The note's first blank line is spent on that separation, exactly as Markdown intends: it's
// what a paragraph break is written with, so it buys no empty line. Every blank line *past* the
// first is a deliberate one and comes back as a block of its own holding a non-breaking space —
// not a blank line by Markdown's definition (only spaces and tabs make a line blank), so it
// survives as a real, visibly empty line. A run of N blank lines therefore renders as N-1 empty
// lines: two for one, three for two, and so on.
//
// The blank lines themselves stay around the fillers — they're what keeps the neighbouring
// tables, lists, fenced code and headings parsing as blocks. Two runs are left exactly as they
// were: those inside fenced code, where a filler would read as code, and those touching a
// container tag, whose contents aren't free text.
//
// A non-breaking space rather than <br>: Rich Markdown does take HTML tags inline, but if a
// given tag isn't honoured the message shows the literal markup, while an unhonoured filler
// character is at worst invisible.
function materializeBlankLines(text: string): string {
    const stashed: string[] = [];
    const stash = (s: string): string => `\x00BL${stashed.push(s) - 1}\x00`;
    const stashedText = text.replace(/```[\s\S]*?```/g, stash);   // fenced code blocks

    const lines = stashedText.split("\n");
    const isBlank = (line: string): boolean => line.trim().length === 0;
    const out: string[] = [];

    for (let i = 0; i < lines.length;) {
        if (!isBlank(lines[i])) { out.push(lines[i++]); continue; }
        // The whole run of blank lines, and the content lines on either side of it. Runs at the
        // very start or end can't happen (the text is trimmed first), but an unfilled run there
        // would only re-add the padding that was just dropped, so they're left alone too.
        let end = i;
        while (end < lines.length && isBlank(lines[end])) end++;
        const before = out.length > 0 ? out[out.length - 1] : null;
        const after = end < lines.length ? lines[end] : null;
        const fillers = end - i - 1;   // the first blank line is the block separator itself
        if (fillers === 0 || before === null || after === null
            || CONTAINER_TAG_LINE.test(before) || CONTAINER_TAG_LINE.test(after)) {
            out.push(...lines.slice(i, end));
        } else {
            out.push("");
            for (let n = 0; n < fillers; n++) out.push(BLANK_LINE_FILLER, "");
        }
        i = end;
    }

    // eslint-disable-next-line no-control-regex -- \x00 sentinels delimit stashed code spans
    return out.join("\n").replace(/\x00BL(\d+)\x00/g, (_, i: string) => stashed[parseInt(i)]);
}

// Telegram Rich Markdown reads a leading #word as a heading, so an Obsidian hashtag
// renders as a heading instead of a clickable tag. Escaping it (\#word) makes Telegram
// emit the literal #word, which it then auto-links as a hashtag.
//
// A hashtag is a # at line start or after whitespace, directly followed by tag characters
// (letters/digits/_/-/ /) that include at least one letter or underscore. That excludes
// "# heading" (the space after # means it isn't matched) and purely numeric "#123".
// Fenced and inline code are stashed first so genuine '#' usage there (#define, #id, …)
// is left alone.
function escapeRichHashtags(text: string): string {
    const stashed: string[] = [];
    const stash = (s: string): string => `\x00H${stashed.push(s) - 1}\x00`;

    let out = text
        .replace(/```[\s\S]*?```/g, stash)   // fenced code blocks
        .replace(/`[^`\n]+`/g, stash);       // inline code spans

    out = out.replace(
        /(^|\s)#([\p{L}\p{N}_/-]*[\p{L}_][\p{L}\p{N}_/-]*)/gmu,
        (_, pre: string, tag: string) => `${pre}\\#${tag}`
    );

    // eslint-disable-next-line no-control-regex -- \x00 sentinels delimit stashed code spans
    return out.replace(/\x00H(\d+)\x00/g, (_, i: string) => stashed[parseInt(i)]);
}

// Converts Obsidian markdown directly to Telegram-compatible HTML
// for GramJS HTMLParser (supports: b, i, u, s, code, pre, blockquote, a, spoiler)
export function mdToTelegramHtml(body: string): string {
    const stripped = stripObsidianSyntax(body);

    // Protect code blocks and inline code from further processing
    const codeBlocks: string[] = [];
    let text = stripped
        .replace(/```(\w*)\n([\s\S]*?)\n?```/g, (_, _lang: string, code: string) => {
            codeBlocks.push(`<pre>${escHtml(code)}</pre>`);
            return `\x00CB${codeBlocks.length - 1}\x00`;
        })
        .replace(/`([^`\n]+)`/g, (_, c: string) => {
            codeBlocks.push(`<code>${escHtml(c)}</code>`);
            return `\x00CB${codeBlocks.length - 1}\x00`;
        });

    // Protect escaped characters (\* \_ \~ etc.) from formatting
    const escapes: string[] = [];
    text = text.replace(/\\([\\*_~`|>\-[\](){}#+.!])/g, (_, ch: string) => {
        escapes.push(ch);
        return `\x00ES${escapes.length - 1}\x00`;
    });

    // Blockquote: lines starting with > plus lazy continuations (non-empty lines without >)
    const lines = text.split('\n');
    const processed: string[] = [];
    let quoteLines: string[] = [];
    let inQuote = false;

    for (const line of lines) {
        if (/^>/.test(line)) {
            inQuote = true;
            quoteLines.push(line.replace(/^>[ \t]?/, ''));
        } else if (inQuote && line.trim() !== '' && !/^#{1,6}\s/.test(line)) {
            quoteLines.push(line);
        } else {
            if (inQuote) {
                processed.push(`<blockquote>${quoteLines.join('\n').trimEnd()}</blockquote>`);
                quoteLines = [];
                inQuote = false;
            }
            processed.push(line);
        }
    }
    if (inQuote) {
        processed.push(`<blockquote>${quoteLines.join('\n').trimEnd()}</blockquote>`);
    }
    text = processed.join('\n');

    // Thematic breaks (---, ___, ***) → horizontal line, preserving length
    text = text.replace(/^[ \t]*([-_*])\1{2,}[ \t]*$/gm, (match) => {
        const len = match.trim().length;
        return '\u2500'.repeat(len);
    });

    // Unordered list markers (*, +, -) → bullet •
    text = text.replace(/^(\s*)(?:\*|\+|-)\s+/gm, '$1• ');

    // Separate consecutive ordered-list items when the delimiter changes (. vs )),
    // mirroring how distinct ordered lists are rendered.
    const olines = text.split('\n');
    const olist: string[] = [];
    let prevDelim: string | null = null;
    for (const line of olines) {
        const m = line.match(/^\s*\d+([.)])\s+/);
        if (m) {
            if (prevDelim && m[1] !== prevDelim && olist.length && olist[olist.length - 1].trim() !== '') {
                olist.push('');
            }
            prevDelim = m[1];
        } else {
            prevDelim = null;
        }
        olist.push(line);
    }
    text = olist.join('\n');

    // Headings → bold, set off by a blank line before and after
    text = text.replace(/^#{1,6}\s+(.+)$/gm, '\n<b>$1</b>\n');

    // Bold **text** (multiline: wrap each line separately)
    text = text.replace(/\*\*([^\s*][\s\S]*?)\*\*/g, (_, content: string) =>
        content.split('\n').map((line: string) => `<b>${line}</b>`).join('\n'));

    // Italic *text* or _text_  (multiline: wrap each line separately)
    text = text.replace(/\*([^\s*][\s\S]*?)\*/g, (_, content: string) =>
        content.split('\n').map((line: string) => `<i>${line}</i>`).join('\n'));
    text = text.replace(/(?<![\\a-zA-Zа-яА-ЯёЁ])_([^\s_][\s\S]*?)_(?![a-zA-Zа-яА-ЯёЁ])/g, (_, content: string) =>
        content.split('\n').map((line: string) => `<i>${line}</i>`).join('\n'));

    // Strikethrough ~~text~~  (multiline: wrap each line separately)
    text = text.replace(/~~([^\s~][\s\S]*?)~~/g, (_, content: string) =>
        content.split('\n').map((line: string) => `<s>${line}</s>`).join('\n'));

    // Spoiler ||text||  (multiline: wrap each line separately)
    // NOTE: produces <spoiler> for GramJS HTMLParser; Bot API callers must use mdToBotApiHtml.
    text = text.replace(/\|\|([^\s|][\s\S]*?)\|\|/g, (_, content: string) =>
        content.split('\n').map((line: string) => `<spoiler>${line}</spoiler>`).join('\n'));

    // Custom emoji, before the generic link rule so they don't become plain links.
    text = customEmojiToHtml(text);

    // Links [text](url) — URL may contain balanced parentheses
    text = text.replace(/\[([^\]]+)\]\(((?:[^()]|\([^()]*\))+)\)/g, '<a href="$2">$1</a>');

    // Restore escaped characters as literal text
    // eslint-disable-next-line no-control-regex -- \x00 sentinels delimit protected escape spans
    text = text.replace(/\x00ES(\d+)\x00/g, (_, idx: string) => escHtml(escapes[parseInt(idx)]));

    // Restore code blocks
    // eslint-disable-next-line no-control-regex -- \x00 sentinels delimit protected code spans
    text = text.replace(/\x00CB(\d+)\x00/g, (_, idx: string) => codeBlocks[parseInt(idx)]);

    // Collapse multiple blank lines into one
    text = text.replace(/\n{3,}/g, '\n\n');

    return text.replace(/^\n+|\n+$/g, '');
}

// Tags supported by the Bot API's parse_mode:"HTML".
// Any other HTML tag that slips through from raw note content is stripped (content kept).
const BOT_API_ALLOWED_TAGS = /^(?:b|strong|i|em|u|ins|s|strike|del|code|pre|a|tg-spoiler|tg-emoji|blockquote)$/i;

// Adapts mdToTelegramHtml output for the Bot API's HTML parse mode:
//   - replaces GramJS's <spoiler> with Bot API's <tg-spoiler>
//   - strips any tag not in the Bot API whitelist (content is kept)
export function mdToBotApiHtml(body: string): string {
    let text = mdToTelegramHtml(body);
    text = text.replace(/<(\/?)spoiler>/g, '<$1tg-spoiler>');
    text = text.replace(/<(\/?)([a-z][a-z0-9-]*)(\s[^>]*)?>/gi, (match: string, _slash: string, tag: string) =>
        BOT_API_ALLOWED_TAGS.test(tag) ? match : '');
    return text;
}
