// emoji.ts
// Emoji picker: a Telegram-style emoji bar for the note editor. The emoji themselves come
// from emoji-data.ts — the full standard emoji set, grouped into the same sections
// Telegram Desktop's panel uses (People, Nature, Food, Activity, Travel, Objects,
// Symbols) — so the bar is available instantly and offline, with no account needed.
//
// Note on Telegram's emoji APIs: messages.getEmojiGroups serves the *search* categories
// (the emotion-based rows Telegram shows above emoji search: "smiling", "love", "angry"),
// not the panel's sections, and covers only a subset of the set. The panel's own grouping
// is client-side data in Telegram Desktop, which is what emoji-data.ts mirrors.
import { Editor, setIcon, setTooltip } from "obsidian";
import { t } from "../lang/helpers";
import { emojiSections, searchEmoji, searchCustomEmoji, parseCustomEmojiRef, customEmojiRef } from "./emoji-search";
import { CustomEmojiThumbnails } from "./custom-emoji";
import { CustomEmojiSet } from "./types";

// One tile in the grid: what gets written into the note, the glyph shown while no preview
// is available, and — for custom emoji — the document id its preview is fetched by.
interface PickerItem {
    insert: string;
    alt: string;
    customId?: string;
}

// Recently used emoji kept for the "Recent" section, as in Telegram's panel.
export const RECENT_EMOJI_LIMIT = 32;

// Localized headings for the sections emoji-data.ts ships, keyed by section id.
const SECTION_TITLES: Record<string, string> = {
    people: t.EMOJI_SECTION_PEOPLE,
    nature: t.EMOJI_SECTION_NATURE,
    food: t.EMOJI_SECTION_FOOD,
    activity: t.EMOJI_SECTION_ACTIVITY,
    travel: t.EMOJI_SECTION_TRAVEL,
    objects: t.EMOJI_SECTION_OBJECTS,
    symbols: t.EMOJI_SECTION_SYMBOLS,
};

// A stored recent is either a plain emoji or a custom-emoji reference, exactly as it was
// inserted into the note.
function toPickerItem(recent: string): PickerItem {
    const custom = parseCustomEmojiRef(recent);
    return custom
        ? { insert: recent, alt: custom.alt, customId: custom.id }
        : { insert: recent, alt: recent };
}

// The cursor's on-screen rectangle, used to anchor the panel under the current line.
// Obsidian's Editor wraps a CodeMirror 6 view that isn't in the public typings, so the
// view is read structurally and the visible caret element serves as the fallback.
function cursorRect(editor: Editor): { left: number; top: number; bottom: number } | null {
    const cm = (editor as unknown as {
        cm?: {
            coordsAtPos?: (pos: number) => { left: number; top: number; bottom: number } | null;
            scrollDOM?: HTMLElement;
        };
    }).cm;
    try {
        const coords = cm?.coordsAtPos?.(editor.posToOffset(editor.getCursor("head")));
        // A cursor scrolled out of the note's visible area gives coordinates outside the
        // scroller — anchoring to those would leave the bar floating over unrelated UI.
        const scroller = cm?.scrollDOM?.getBoundingClientRect();
        if (coords && scroller && (coords.bottom < scroller.top || coords.top > scroller.bottom)) return null;
        if (coords) return coords;
    } catch { /* view detached or position out of range — fall through to the caret */ }
    const caret = activeDocument.querySelector(".workspace-leaf.mod-active .cm-cursor-primary");
    if (caret) {
        const rect = caret.getBoundingClientRect();
        return { left: rect.left, top: rect.top, bottom: rect.bottom };
    }
    return null;
}

// A floating emoji bar anchored under the editor's current line: a search field and
// category tabs on top, a scrollable grid of emoji below — Telegram's emoji panel.
// Clicking an emoji inserts it at the cursor and keeps the panel open (as Telegram does),
// so several can be picked in a row.
export class EmojiPicker {
    // Only one bar at a time — opening a second one closes the first.
    private static current: EmojiPicker | null = null;

    private readonly editor: Editor;
    private readonly onPick: (inserted: string) => void;
    private readonly recent: string[];
    // Custom emoji packs installed on the account, appended after the standard sections,
    // and the loader for their preview images (both absent without an account).
    private customSets: CustomEmojiSet[];
    private readonly thumbnails: CustomEmojiThumbnails | null;

    private panelEl!: HTMLElement;
    private searchEl!: HTMLInputElement;
    private tabsEl!: HTMLElement;
    private scrollEl!: HTMLElement;
    private tabs: Array<{ btn: HTMLElement; sectionEl: HTMLElement }> = [];
    // Watches custom-emoji tiles so their previews download only once they scroll into view.
    private thumbObserver: IntersectionObserver | null = null;
    // Set while a tab click is scrolling the list, so the scroll handler doesn't fight it.
    private scrollingToSection = false;
    private closed = false;
    private detach: Array<() => void> = [];

    constructor(
        editor: Editor,
        recent: string[],
        onPick: (inserted: string) => void,
        custom: { sets?: CustomEmojiSet[]; thumbnails?: CustomEmojiThumbnails | null } = {},
    ) {
        this.editor = editor;
        this.recent = recent;
        this.onPick = onPick;
        this.customSets = custom.sets ?? [];
        this.thumbnails = custom.thumbnails ?? null;
    }

    // Closes whichever bar is open; the return value lets the command toggle (pressing the
    // hotkey again while the bar is open dismisses it instead of rebuilding it).
    static closeCurrent(): boolean {
        if (!EmojiPicker.current) return false;
        EmojiPicker.current.close(true);
        return true;
    }

    open(): void {
        EmojiPicker.closeCurrent();
        EmojiPicker.current = this;

        this.panelEl = activeDocument.body.createDiv("telegram-emoji-panel");

        // ── Search row ──
        const searchRowEl = this.panelEl.createDiv("telegram-emoji-search");
        setIcon(searchRowEl.createSpan("telegram-emoji-search-icon"), "search");
        this.searchEl = searchRowEl.createEl("input", {
            cls: "telegram-emoji-search-input",
            attr: { type: "text", placeholder: t.EMOJI_SEARCH_PLACEHOLDER },
        });
        this.searchEl.addEventListener("input", () => this.renderBody());
        this.searchEl.addEventListener("keydown", (event: KeyboardEvent) => {
            // Enter takes the first hit, so a search can be finished without the mouse.
            if (event.key !== "Enter") return;
            event.preventDefault();
            const first = this.scrollEl.querySelector<HTMLElement>(".telegram-emoji-btn");
            first?.click();
        });

        this.tabsEl = this.panelEl.createDiv("telegram-emoji-tabs");
        this.scrollEl = this.panelEl.createDiv("telegram-emoji-scroll");
        // Scrolling the grid moves the tab highlight along with it, as Telegram's panel does.
        this.scrollEl.addEventListener("scroll", () => {
            if (!this.scrollingToSection) this.syncActiveTab();
        });
        // One delegated handler for the whole grid — the set runs to ~1900 buttons, which
        // aren't worth a listener each.
        this.scrollEl.addEventListener("click", event => {
            const btn = (event.target as HTMLElement).closest<HTMLElement>(".telegram-emoji-btn");
            if (btn?.dataset.insert) this.pick(btn.dataset.insert);
        });
        // Custom emoji previews are fetched only for the tiles in (or near) view — a pack
        // can hold hundreds, and each preview is a round trip.
        if (this.thumbnails) {
            this.thumbObserver = new IntersectionObserver(entries => {
                const ids: string[] = [];
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const el = entry.target as HTMLElement;
                    this.thumbObserver?.unobserve(el);
                    if (el.dataset.emojiId) ids.push(el.dataset.emojiId);
                }
                if (ids.length > 0) void this.loadThumbnails(ids);
            }, { root: this.scrollEl, rootMargin: "120px" });
        }
        this.renderBody();

        // A click inside the panel must not steal focus from the editor — the cursor has to
        // stay where the emoji will be inserted, so the mousedown is swallowed and only the
        // click acts. The search field is the exception: it has to be focusable to type in.
        this.panelEl.addEventListener("mousedown", event => {
            if (event.target !== this.searchEl) event.preventDefault();
        });

        const onPointerDown = (event: MouseEvent) => {
            if (!this.panelEl.contains(event.target as Node)) this.close();
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                this.close(true);
            }
        };
        // Reposition while the note scrolls / the window resizes; the bar closes once the
        // line it belongs to is no longer visible. The panel's own grid scrolling is not a
        // reason to recompute anything.
        const onReposition = (event?: Event) => {
            if (event && this.panelEl.contains(event.target as Node)) return;
            this.position();
        };
        activeDocument.addEventListener("mousedown", onPointerDown, true);
        activeDocument.addEventListener("keydown", onKeyDown, true);
        activeWindow.addEventListener("resize", onReposition);
        activeDocument.addEventListener("scroll", onReposition, true);
        this.detach.push(
            () => activeDocument.removeEventListener("mousedown", onPointerDown, true),
            () => activeDocument.removeEventListener("keydown", onKeyDown, true),
            () => activeWindow.removeEventListener("resize", onReposition),
            () => activeDocument.removeEventListener("scroll", onReposition, true),
        );

        this.position();
    }

    // `refocus` puts the caret back in the note — right for Escape, wrong for a click that
    // deliberately moved focus somewhere else (another pane, the settings, a search field).
    close(refocus = false): void {
        if (this.closed) return;
        this.closed = true;
        if (EmojiPicker.current === this) EmojiPicker.current = null;
        for (const off of this.detach) off();
        this.detach = [];
        this.thumbObserver?.disconnect();
        this.thumbObserver = null;
        // Closes the custom-emoji connection; the previews already downloaded stay cached.
        this.thumbnails?.dispose();
        this.panelEl.remove();
        if (refocus) this.editor.focus();
    }

    get isOpen(): boolean {
        return !this.closed;
    }

    // Swaps in a freshly loaded pack list (the background refresh) without disturbing an
    // open panel more than necessary — nothing to do while the user is searching.
    setCustomSets(sets: CustomEmojiSet[]): void {
        if (this.closed) return;
        this.customSets = sets;
        if (!this.searchEl.value.trim()) this.renderBody();
    }

    // Browsing shows the tabs and one grid per section; searching replaces both with a
    // single flat result grid (the tabs would have nothing to jump to).
    private renderBody(): void {
        const query = this.searchEl.value.trim();
        this.scrollEl.empty();
        this.scrollEl.scrollTop = 0;
        this.tabs = [];
        this.tabsEl.empty();
        this.tabsEl.toggle(!query);

        if (query) {
            // Custom emoji join the results, matched through their fallback emoji and their
            // pack name, and lead — they're the ones a search is usually after.
            const custom = searchCustomEmoji(this.customSets, query).map(hit => ({
                insert: customEmojiRef(hit.alt, hit.id),
                alt: hit.alt,
                customId: hit.id,
            }));
            const standard = searchEmoji(query).map(entry => ({ insert: entry.emoji, alt: entry.emoji }));
            const results = [...custom, ...standard];
            if (results.length === 0) {
                this.scrollEl.createDiv({ text: t.EMOJI_NO_RESULTS, cls: "telegram-emoji-message" });
            } else {
                this.renderGrid(this.scrollEl, results);
            }
            this.position();
            return;
        }

        // "Recent" leads, exactly as in Telegram's panel; then the standard sections, then
        // one section per installed custom emoji pack.
        const sections: Array<{ title: string; icon: string | null; items: PickerItem[] }> = [];
        if (this.recent.length > 0) {
            sections.push({ title: t.EMOJI_RECENT, icon: null, items: this.recent.map(toPickerItem) });
        }
        for (const section of emojiSections()) {
            sections.push({
                title: SECTION_TITLES[section.key] ?? section.key,
                icon: section.icon,
                items: section.entries.map(entry => ({ insert: entry.emoji, alt: entry.emoji })),
            });
        }
        for (const set of this.customSets) {
            sections.push({
                title: set.title,
                // The pack's own artwork isn't rendered in the tab strip; its first emoji's
                // fallback glyph identifies it well enough.
                icon: set.entries[0]?.alt ?? "⭐",
                items: set.entries.map(entry => ({
                    insert: customEmojiRef(entry.alt, entry.id),
                    alt: entry.alt,
                    customId: entry.id,
                })),
            });
        }

        for (const section of sections) {
            const sectionEl = this.scrollEl.createDiv("telegram-emoji-section");
            sectionEl.createDiv({ text: section.title, cls: "telegram-emoji-section-title" });
            this.renderGrid(sectionEl, section.items);

            const tabBtn = this.tabsEl.createEl("button", { cls: "telegram-emoji-tab", attr: { type: "button" } });
            // Telegram marks its recents with a clock; every other tab shows the section's glyph.
            if (section.icon) tabBtn.setText(section.icon);
            else setIcon(tabBtn, "clock");
            setTooltip(tabBtn, section.title);
            tabBtn.addEventListener("click", () => this.scrollToSection(sectionEl));
            this.tabs.push({ btn: tabBtn, sectionEl });
        }

        this.syncActiveTab();
        this.position();
    }

    private renderGrid(parentEl: HTMLElement, items: PickerItem[]): void {
        const gridEl = parentEl.createDiv("telegram-emoji-grid");
        for (const item of items) {
            const btn = gridEl.createEl("button", {
                cls: "telegram-emoji-btn",
                attr: { type: "button", "aria-label": item.alt, "data-insert": item.insert },
            });
            if (!item.customId) {
                btn.setText(item.insert);
                continue;
            }
            // Custom emoji show their own artwork; until it's downloaded (or if it can't be),
            // the fallback emoji stands in — the same glyph Telegram shows in its place.
            btn.addClass("is-custom");
            btn.dataset.emojiId = item.customId;
            const cached = CustomEmojiThumbnails.cached(item.customId);
            if (cached) this.setTileImage(btn, cached, item.alt);
            else {
                btn.setText(item.alt);
                this.thumbObserver?.observe(btn);
            }
        }
    }

    private setTileImage(btn: HTMLElement, url: string, alt: string): void {
        btn.empty();
        const img = btn.createEl("img", { cls: "telegram-emoji-image", attr: { alt } });
        img.src = url;
        // A broken preview falls back to the glyph rather than an empty tile.
        img.addEventListener("error", () => { btn.empty(); btn.setText(alt); });
    }

    // Downloads the previews of the tiles that just scrolled into view and swaps them in.
    private async loadThumbnails(ids: string[]): Promise<void> {
        if (!this.thumbnails) return;
        await this.thumbnails.load(ids);
        if (this.closed) return;
        for (const id of ids) {
            const url = CustomEmojiThumbnails.cached(id);
            if (!url) continue;
            this.panelEl.querySelectorAll<HTMLElement>(`.telegram-emoji-btn[data-emoji-id="${id}"]`)
                .forEach(btn => this.setTileImage(btn, url, btn.getAttr("aria-label") ?? ""));
        }
    }

    private pick(inserted: string): void {
        this.editor.replaceSelection(inserted);
        // Typing in the search field keeps the focus there; otherwise the caret goes back
        // to the note so the user can keep writing straight away.
        if (activeDocument.activeElement !== this.searchEl) this.editor.focus();
        this.onPick(inserted);
    }

    private scrollToSection(sectionEl: HTMLElement): void {
        this.scrollingToSection = true;
        this.scrollEl.scrollTop = sectionEl.offsetTop - this.scrollEl.offsetTop;
        this.setActiveTab(sectionEl);
        window.requestAnimationFrame(() => { this.scrollingToSection = false; });
    }

    // Highlights the tab of the section currently at the top of the scroll area.
    private syncActiveTab(): void {
        const cutoff = this.scrollEl.scrollTop + this.scrollEl.offsetTop + 1;
        let active = this.tabs[0]?.sectionEl;
        for (const tab of this.tabs) {
            if (tab.sectionEl.offsetTop <= cutoff) active = tab.sectionEl;
        }
        if (active) this.setActiveTab(active);
    }

    private setActiveTab(sectionEl: HTMLElement): void {
        for (const tab of this.tabs) tab.btn.toggleClass("is-active", tab.sectionEl === sectionEl);
    }

    // Anchors the panel under the current line, flipping above it when the space below is
    // too small and clamping to the window. The bar closes when the cursor scrolls away.
    private position(): void {
        if (this.closed) return;
        const cursor = cursorRect(this.editor);
        if (!cursor) { this.close(); return; }

        const margin = 8;
        const gap = 4;
        const { offsetWidth: width, offsetHeight: height } = this.panelEl;
        const left = Math.max(margin, Math.min(cursor.left, activeWindow.innerWidth - width - margin));

        let top = cursor.bottom + gap;
        if (top + height > activeWindow.innerHeight - margin) {
            const above = cursor.top - height - gap;
            top = above >= margin ? above : Math.max(margin, activeWindow.innerHeight - height - margin);
        }
        this.panelEl.style.left = `${left}px`;
        this.panelEl.style.top = `${top}px`;
    }
}
