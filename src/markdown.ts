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

// keepRichMediaEmbeds: when true (Rich Markdown path), HTTP(S) media embeds are
// preserved so Telegram renders them as media blocks. The GramJS HTML path leaves
// it false because that parser can't express URL media blocks.
export function stripObsidianSyntax(body: string, opts: { keepRichMediaEmbeds?: boolean } = {}): string {
    return body
        .replace(/%%[\s\S]*?%%/g, "")             // Strip Obsidian comments %% ... %%
        .replace(/!\[\[[^\]]*\]\]/g, "")           // Strip wikilink embeds (always local)
        .replace(/!\[[^\]]*\]\(([^)]*)\)/g, (match, target: string) =>
            opts.keepRichMediaEmbeds && isRichEmbeddableUrl(target) ? match : "")
        .replace(/!\([^)]*\)\[[^\]]*\]/g, "")      // Strip reversed MD embeds !()[]
        .replace(/<!--[\s\S]*?-->/g, "")           // Strip HTML comments
        .replace(/<!--/g, "")                      // Strip any orphaned comment openers left after the pass above
        .replace(/[ \t]+\n/g, "\n")
        .trim();
}

export function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
// HTTP(S) image/video/audio embeds are kept (keepRichMediaEmbeds) so Telegram
// renders them inline as media blocks; only local embeds (which can't be a URL
// media block and must be uploaded separately) are stripped.
export function obsidianToRichMarkdown(body: string): string {
    let text = stripObsidianSyntax(body, { keepRichMediaEmbeds: true });

    // [[target]], [[target|alias]], [[target#heading]], [[target#heading|alias]] → alias ?? target
    text = text.replace(
        /\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|([^[\]]+))?\]\]/g,
        (_, target: string, alias?: string) => (alias ?? target).trim()
    );

    return text.trim();
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
