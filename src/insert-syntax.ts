// insert-syntax.ts
// The markup the insert window (src/insert-modal.ts) writes for media, formulas and
// references. No Obsidian imports: the window resolves vault files to link text first.

// ─── Media ────────────────────────────────────────────────────────────────────

export type MediaLayout = "single" | "collage" | "slideshow";

// A media embed with a caption. Rich Markdown reads the title after the URL as the caption
// (`![](photo.jpg "Caption")`), so the Markdown form is used even for a vault file: `target` is
// its link text or a web URL. Spaces and brackets in the path are percent-encoded so the
// target stays one token (other characters, Cyrillic included, stay readable); a `"` in the
// caption is written as an entity, as Markdown allows.
export function captionedEmbed(target: string, caption: string): string {
    const isUrl = /^https?:\/\//i.test(target);
    const path = (isUrl ? target : target.replace(/%/g, "%25"))
        .replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
    return `![](${path} "${caption.trim().replace(/"/g, "&quot;")}")`;
}

// A collage or slideshow: the media as Markdown blocks inside the tag, which Rich Markdown
// parses there, and the caption as a <figcaption> after them.
export function mediaGroup(layout: "collage" | "slideshow", embeds: string[], caption: string): string {
    const tag = layout === "collage" ? "tg-collage" : "tg-slideshow";
    const text = caption.trim();
    const parts = [`<${tag}>`, "", embeds.join("\n")];
    if (text) parts.push("", `<figcaption>${text}</figcaption>`);
    parts.push("", `</${tag}>`);
    return parts.join("\n");
}

// ─── Formulas ─────────────────────────────────────────────────────────────────

// A LaTeX formula in the `$…$` / `$$…$$` form both Obsidian and Rich Markdown render. Kept on
// one line: line breaks mean nothing to LaTeX, but a `$$` block split across lines isn't one
// Telegram documents.
export function mathMarkdown(source: string, display: boolean): string {
    const tex = source.trim().replace(/\s*\n\s*/g, " ");
    return display ? `$$${tex}$$` : `$${tex}$`;
}

// ─── References ───────────────────────────────────────────────────────────────

// A reference name usable in `href="#…"`: no spaces, quotes or angle brackets.
export function referenceName(value: string): string {
    return value.trim().replace(/\s+/g, "-").replace(/["'<>#&]/g, "");
}

// Every reference and anchor name already in the note, in order, without repeats.
export function referenceNames(text: string): string[] {
    const names = Array.from(text.matchAll(/<(?:tg-reference|a)\b[^>]*\bname\s*=\s*["']([^"']+)["']/gi), m => m[1]);
    return [...new Set(names)];
}

// The first `note-N` name that isn't taken yet.
export function nextReferenceName(text: string): string {
    const taken = new Set(referenceNames(text));
    let n = 1;
    while (taken.has(`note-${n}`)) n++;
    return `note-${n}`;
}

export function referenceLink(name: string, text: string): string {
    return `<a href="#${name}">${text}</a>`;
}

export function referenceText(name: string, text: string): string {
    return `<tg-reference name="${name}">${text}</tg-reference>`;
}
