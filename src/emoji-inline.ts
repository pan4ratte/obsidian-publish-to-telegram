// emoji-inline.ts
// Renders custom emoji inline in Obsidian itself. A picked custom emoji is stored in the
// note as `[👍](tg://emoji?id=…)`; on its own that reads as a link with a fallback glyph, so
// here the reference is drawn as the actual artwork — in Live Preview (a CodeMirror
// decoration) and in Reading view / rendered previews (a markdown post-processor).
//
// Artwork comes from the same loader the picker uses: whatever is cached shows instantly,
// the rest is fetched and swapped in when it arrives. Without an authorized account only
// the on-disk cache is available, and anything missing keeps its fallback emoji.
import { MarkdownPostProcessor } from "obsidian";
import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { CustomEmojiThumbnails } from "./custom-emoji";
import { customEmojiRefRegex } from "./markdown";

// Fills `el` with the emoji's artwork, or its fallback glyph until that arrives. Returns
// nothing: late-arriving previews come back through the loader's subscription.
function renderCustomEmoji(el: HTMLElement, alt: string, id: string, previews: CustomEmojiThumbnails | null): void {
    el.empty();
    el.addClass("telegram-inline-emoji");
    el.dataset.emojiId = id;
    el.dataset.fallback = alt;

    const preview = CustomEmojiThumbnails.cached(id);
    if (!preview) {
        el.setText(alt);
        void previews?.load([id]);
        return;
    }
    el.toggleClass("is-placeholder", preview.placeholder === true);
    const onError = () => { el.empty(); el.setText(alt); };
    if (preview.kind === "video") {
        const video = el.createEl("video");
        video.autoplay = true;
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        video.src = preview.url;
        video.addEventListener("error", onError);
        return;
    }
    const img = el.createEl("img", { attr: { alt } });
    img.src = preview.url;
    img.addEventListener("error", onError);
}

// Re-renders every inline emoji for these ids, anywhere in the app. Called when previews
// finish loading — cheap enough, since the selector only matches custom emoji elements.
export function refreshInlineEmoji(ids: string[], previews: CustomEmojiThumbnails | null): void {
    for (const id of ids) {
        activeDocument.querySelectorAll<HTMLElement>(`.telegram-inline-emoji[data-emoji-id="${id}"]`)
            .forEach(el => renderCustomEmoji(el, el.dataset.fallback ?? "", id, previews));
    }
}

// ─── Reading view / rendered markdown ─────────────────────────────────────────

// Replaces the rendered `tg://emoji?id=…` links with the artwork. Also covers the post
// previews in the publish modal, which go through the same rendering pipeline.
export function customEmojiPostProcessor(previews: () => CustomEmojiThumbnails | null): MarkdownPostProcessor {
    return (el: HTMLElement) => {
        const links = el.querySelectorAll<HTMLAnchorElement>('a[href^="tg://emoji?id="]');
        if (links.length === 0) return;
        const loader = previews();
        links.forEach(link => {
            const id = /id=(\d+)/.exec(link.getAttribute("href") ?? "")?.[1];
            if (!id) return;
            const span = createSpan();
            renderCustomEmoji(span, link.textContent ?? "", id, loader);
            link.replaceWith(span);
        });
    };
}

// ─── Live Preview ─────────────────────────────────────────────────────────────

class CustomEmojiWidget extends WidgetType {
    constructor(
        private readonly alt: string,
        private readonly id: string,
        private readonly previews: () => CustomEmojiThumbnails | null,
    ) {
        super();
    }

    // Same emoji → keep the existing DOM (and its loaded artwork) on re-render.
    eq(other: CustomEmojiWidget): boolean {
        return other.id === this.id && other.alt === this.alt;
    }

    toDOM(): HTMLElement {
        const span = createSpan();
        renderCustomEmoji(span, this.alt, this.id, this.previews());
        return span;
    }

    // Let CodeMirror handle clicks, so clicking the emoji puts the cursor next to it and
    // reveals the underlying markdown, like Obsidian's own inline widgets.
    ignoreEvent(): boolean {
        return false;
    }
}

// A reference inside code (fenced or inline) is content, not an emoji to draw.
function insideCode(state: EditorState, pos: number): boolean {
    for (let node = syntaxTree(state).resolveInner(pos, 1) as { name: string; parent: unknown } | null; node; node = node.parent as typeof node) {
        if (/code|math/i.test(node.name)) return true;
    }
    return false;
}

// The source stays visible while the cursor or selection is on it, so the reference can
// still be edited or deleted as plain text.
function selectionTouches(state: EditorState, from: number, to: number): boolean {
    return state.selection.ranges.some(range => range.from <= to && range.to >= from);
}

export function customEmojiEditorExtension(previews: () => CustomEmojiThumbnails | null): Extension {
    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;

            constructor(view: EditorView) {
                this.decorations = this.build(view);
            }

            update(update: ViewUpdate): void {
                if (update.docChanged || update.viewportChanged || update.selectionSet) {
                    this.decorations = this.build(update.view);
                }
            }

            private build(view: EditorView): DecorationSet {
                const builder = new RangeSetBuilder<Decoration>();
                const wanted: string[] = [];
                for (const { from, to } of view.visibleRanges) {
                    const text = view.state.doc.sliceString(from, to);
                    const regex = customEmojiRefRegex();
                    let match: RegExpExecArray | null;
                    while ((match = regex.exec(text)) !== null) {
                        const start = from + match.index;
                        const end = start + match[0].length;
                        if (selectionTouches(view.state, start, end) || insideCode(view.state, start)) continue;
                        builder.add(start, end, Decoration.replace({
                            widget: new CustomEmojiWidget(match[1], match[2], previews),
                        }));
                        // Only ask for emoji we have no preview for yet; re-requesting ones
                        // already drawn would reload them on every keystroke.
                        if (!CustomEmojiThumbnails.cached(match[2])) wanted.push(match[2]);
                    }
                }
                // One request per render pass rather than one per emoji.
                if (wanted.length > 0) void previews()?.load(wanted);
                return builder.finish();
            }
        },
        { decorations: plugin => plugin.decorations },
    );
}
