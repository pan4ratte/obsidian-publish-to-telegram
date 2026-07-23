// split.ts
// Shared logic for the `%% \split %%` command that breaks a note into separate posts.
// A split marker terminates the post that precedes it; after publishing, each marker
// carries the link(s) of the post it ends (`%% \split t.me/channel/1 | t.me/channel/2 %%`)
// so a later edit can look the link up and recover exactly that post's content.
//
// This module has no Obsidian/Telegram dependencies so both send paths (telegram.ts and
// telegram-bot.ts) and main.ts can share one source of truth for parsing and rewriting.

// ─── Post-link parsing ──────────────────────────────────────────────────────────

// Parses a t.me post link into its chat + message components. Accepts both the canonical
// `https://t.me/…` form (stored in frontmatter) and the bare `t.me/…` form written into
// split markers. A forum-topic post carries an extra topic segment before the message id:
// t.me/c/<channelId>/<topicId>/<messageId> (private) or t.me/<user>/<topicId>/<messageId>
// (public); the message id is always the last segment.
export function parseLinkComponents(link: string): { chatId: string; messageId: number; topicId?: number } | null {
    // The /c/ id may carry a leading "-": supergroups/channels are stored bare and rebuild
    // to the marked "-100<id>", but basic (legacy) groups have no -100 prefix, so their link
    // keeps the sign (t.me/c/-<id>) and rebuilds to the bare marked "-<id>". Prepending -100
    // to a basic group would target the wrong peer and break editing.
    const privateMatch = link.match(/t\.me\/c\/(-?\d+)(?:\/(\d+))?\/(\d+)\/?$/);
    if (privateMatch) {
        const chatId = privateMatch[1].startsWith("-") ? privateMatch[1] : `-100${privateMatch[1]}`;
        return { chatId, messageId: parseInt(privateMatch[3], 10), topicId: privateMatch[2] ? parseInt(privateMatch[2], 10) : undefined };
    }
    const publicMatch = link.match(/t\.me\/([^/]+)(?:\/(\d+))?\/(\d+)\/?$/);
    if (publicMatch) return { chatId: `@${publicMatch[1]}`, messageId: parseInt(publicMatch[3], 10), topicId: publicMatch[2] ? parseInt(publicMatch[2], 10) : undefined };
    return null;
}

// Normalizes a chat id for comparison so "@Channel", "channel" compare consistently.
function normChatId(id: string): string {
    return id.trim().toLowerCase().replace(/^@/, "");
}

// True when two links point at the same message (same chat + message id), regardless of
// protocol prefix or public/private spelling. Falls back to a trimmed string compare for
// anything that isn't a recognizable t.me post link.
export function linksMatch(a: string, b: string): boolean {
    const pa = parseLinkComponents(a);
    const pb = parseLinkComponents(b);
    if (pa && pb) return normChatId(pa.chatId) === normChatId(pb.chatId) && pa.messageId === pb.messageId;
    return a.trim() === b.trim();
}

// The compact form written into split markers: `https://t.me/…` → `t.me/…`.
function shortLink(link: string): string {
    return link.trim().replace(/^https?:\/\//i, "");
}

// Deduplicates a list of links by target message, keeping the first spelling seen.
function dedupeLinks(links: string[]): string[] {
    const out: string[] = [];
    for (const link of links) {
        if (!out.some(existing => linksMatch(existing, link))) out.push(link);
    }
    return out;
}

// ─── Split marker parsing ─────────────────────────────────────────────────────

export interface SplitMarker {
    start: number;                    // body index where the marker line (incl. indent) begins
    end: number;                      // body index right after the matched marker text
    indent: string;                   // leading whitespace, preserved when the marker is rewritten
    style: "obsidian" | "html";       // %% … %%  vs  <!-- … -->
    links: string[];                  // links currently inside the marker
}

export interface SplitPost {
    content: string;                  // trimmed content of this post (what gets sent)
    links: string[];                  // links already recorded in this post's trailing marker
    marker: SplitMarker | null;       // marker terminating this post; null for a trailing post w/o one
}

// A whole marker line: optional links live between `\split` and the closing delimiter.
// Kept as a factory because a `/g` regex carries mutable lastIndex state.
function markerRegex(): RegExp {
    return /^([ \t]*)(?:%%[ \t]*\\split[ \t]*(.*?)[ \t]*%%|<!--[ \t]*\\split[ \t]*(.*?)[ \t]*-->)[ \t]*$/gm;
}

function parseMarkerLinks(raw: string): string[] {
    return raw.split("|").map(s => s.trim()).filter(s => s.length > 0);
}

// True when the body contains at least one split marker (with or without links).
export function hasSplitMarkers(body: string): boolean {
    return markerRegex().test(body);
}

// Splits a note body into posts. Each post is the (trimmed, non-empty) run of content up to
// the next split marker; the marker that terminates it (if any) is attached so its links can
// be read or rewritten. Content after the last marker becomes a trailing post with no marker.
// This is the single source of truth for both splitting-to-send and link-rewriting, so the
// post order here always matches the order posts are published in.
export function parseSplitPosts(body: string): SplitPost[] {
    const re = markerRegex();
    const posts: SplitPost[] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
        const content = body.slice(lastIndex, m.index).trim();
        const style: "obsidian" | "html" = m[2] !== undefined ? "obsidian" : "html";
        const links = parseMarkerLinks(m[2] ?? m[3] ?? "");
        const marker: SplitMarker = { start: m.index, end: m.index + m[0].length, indent: m[1] ?? "", style, links };
        // An empty run before a marker (e.g. two markers in a row) is not a post, but the
        // marker is still consumed; it stays untouched in the body during any rewrite.
        if (content.length > 0) posts.push({ content, links, marker });
        lastIndex = m.index + m[0].length;
        if (re.lastIndex === m.index) re.lastIndex++; // guard against a zero-width match
    }
    const tail = body.slice(lastIndex).trim();
    if (tail.length > 0) posts.push({ content: tail, links: [], marker: null });
    return posts;
}

// The post contents in order — the parts to publish. Mirrors the previous
// splitBodyByMarkers() (trimmed, non-empty runs) but tolerates markers that carry links.
export function splitBodyByMarkers(body: string): string[] {
    return parseSplitPosts(body).map(p => p.content);
}

// Finds the content of the post whose trailing marker records `link`. Used at edit time to
// recover exactly the part that produced the chosen post. Returns null when no marker
// matches (the caller surfaces "add this link to a split command").
export function findPostContentForLink(body: string, link: string): string | null {
    for (const post of parseSplitPosts(body)) {
        if (post.links.some(l => linksMatch(l, link))) return post.content;
    }
    return null;
}

// ─── Split marker rewriting ────────────────────────────────────────────────────

function buildMarkerText(indent: string, style: "obsidian" | "html", links: string[]): string {
    const inner = links.length > 0 ? ` \\split ${links.join(" | ")} ` : ` \\split `;
    return style === "html" ? `${indent}<!--${inner}-->` : `${indent}%%${inner}%%`;
}

// Records published post links into the note body's split markers. `postLinks[i]` holds the
// link(s) produced for the i-th post (parallel to parseSplitPosts order; multiple links when
// a preset posts the same note to several chats). For a post that already has a marker the
// links are appended (deduped by message); for the trailing post that has no marker yet one
// is inserted after its content, so the last post gets a split command automatically. Links
// are stored in the compact `t.me/…` form. Returns the (possibly unchanged) body.
export function writeLinksIntoMarkers(body: string, postLinks: Array<string[] | undefined>): string {
    const posts = parseSplitPosts(body);
    // Only a note that already uses split gets a marker appended to its last post; a note with
    // no split command at all is a single post and is left untouched (its link lives only in
    // the frontmatter, and edits fall back to the whole body).
    const usesSplit = hasSplitMarkers(body);
    interface Edit { start: number; end: number; text: string; }
    const edits: Edit[] = [];

    posts.forEach((post, i) => {
        const fresh = (postLinks[i] ?? []).map(shortLink);
        if (fresh.length === 0) return;
        const merged = dedupeLinks([...post.links, ...fresh]);
        if (post.marker) {
            edits.push({ start: post.marker.start, end: post.marker.end, text: buildMarkerText(post.marker.indent, post.marker.style, merged) });
        } else if (usesSplit) {
            // Trailing post without a marker, in a note that already splits: add the missing
            // split command for the last post. The tail always runs to body end, so insert
            // just past the trimmed content, keeping any trailing whitespace after it.
            const insertPos = body.replace(/[ \t\r\n]*$/, "").length;
            edits.push({ start: insertPos, end: insertPos, text: `\n\n${buildMarkerText("", "obsidian", merged)}` });
        }
    });

    // Apply right-to-left so earlier offsets stay valid as the string length changes.
    edits.sort((a, b) => b.start - a.start);
    let out = body;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return out;
}
