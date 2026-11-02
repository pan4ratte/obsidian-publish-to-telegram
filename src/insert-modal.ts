// insert-modal.ts
// The insert window: one modal with a tab per element that has something to set up — a button
// under the post, a map, media (single, collage, slideshow), a reference, a formula. The editor
// menu opens it on the tab of the item that was chosen; each tab keeps what was typed into it
// while the window is open, and writes its element at the cursor on "Insert".

import {
    AbstractInputSuggest, App, ButtonComponent, Editor, Modal, Notice, Setting, TFile,
    debounce, finishRenderMath, loadMathJax, prepareFuzzySearch, renderMath, setIcon, setTooltip,
} from "obsidian";
import { t } from "../lang/helpers";
import { buttonBlockAt, buttonToHtml, parseButtonEmoji, richKindForExt, type ButtonColor, type InlineButton } from "./markdown";
import { renderButton, requestEmoji } from "./buttons";
import { CustomEmojiThumbnails } from "./custom-emoji";
import { isShortMapLink, mapCheckUrl, mapToHtml, parseMapInput, MAP_ZOOM_MAX, MAP_ZOOM_MIN, type MapPoint } from "./map-link";
import {
    captionedEmbed, mathMarkdown, mediaGroup, nextReferenceName, referenceLink, referenceName,
    referenceNames, referenceText, type MediaLayout,
} from "./insert-syntax";
import { postEndAt } from "./split";
import { errMessage } from "./util";
import { moveSegmentIndicator, watchSegments, watchStageHeight, PANEL_EXIT_MS } from "./segmented-bar";

export type InsertKind = "button" | "map" | "media" | "reference" | "math";
export type ReferenceMode = "both" | "link" | "text";

// What the window opens on: the tab, and the variant the menu item stands for.
export interface InsertPreset {
    kind: InsertKind;
    mediaLayout?: MediaLayout;
    referenceMode?: ReferenceMode;
    mathDisplay?: boolean;
}

interface InsertContext {
    app: App;
    editor: Editor;
    sourcePath: string;
    selection: string;
    previews: () => CustomEmojiThumbnails | null;
}

interface InsertForm {
    // Builds the tab's settings into `el`; `changed` tells the window to re-check isValid().
    render(el: HTMLElement, changed: () => void): void;
    isValid(): boolean;
    insert(): void | Promise<void>;
    // Enter in a field: true when the tab used it (e.g. to add a media item) rather than to insert.
    handleEnter?(target: HTMLElement): boolean;
    // False when the tab's first field shouldn't take the focus as it opens.
    readonly autofocus?: boolean;
    dispose?(): void;
}

// Writes `text` as a block of its own in place of the selection: a block element has to start
// a line, so text on either side is pushed to its own paragraph.
function insertBlock(editor: Editor, text: string): void {
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const before = editor.getLine(from.line).slice(0, from.ch).trim().length > 0 ? "\n\n" : "";
    const after = editor.getLine(to.line).slice(to.ch).trim().length > 0 ? "\n\n" : "";
    editor.replaceRange(`${before}${text}${after}`, from, to);
}

// A setting whose control sits under its name, full width — for text areas.
function stacked(setting: Setting): Setting {
    setting.settingEl.addClass("telegram-insert-stacked");
    return setting;
}

// ─── Button ───────────────────────────────────────────────────────────────────

type ButtonAction = "url" | "copy" | "disabled";

// One button under the post. Inside a `tg-buttons` block it's added there: on a new row below
// the cursor's line, or at the end of that line when "Same row" is on (offered only when the
// cursor is on a line of buttons). Elsewhere it starts a new block.
class ButtonForm implements InsertForm {
    private text: string;
    private action: ButtonAction = "url";
    private url = "";
    private copy = "";
    private color: ButtonColor | "" = "";
    private emoji = "";
    private sameRow = false;

    private readonly block: { contentFrom: number; contentTo: number } | null;
    private readonly rowLine: number | null = null;
    private readonly closeLine: number = 0;

    private previewEl: HTMLElement | null = null;
    private valueSetting: Setting | null = null;
    private changed: () => void = () => {};
    // Typing an id fires on every key; ask for the artwork once it has settled.
    private readonly loadEmoji = debounce(() => requestEmoji([this.button()], this.ctx.previews), 500, true);

    constructor(private readonly ctx: InsertContext) {
        const { editor } = ctx;
        const from = editor.getCursor("from");
        this.block = buttonBlockAt(editor.getValue(), editor.posToOffset(from));
        if (this.block) {
            const firstLine = editor.offsetToPos(this.block.contentFrom).line;
            this.closeLine = editor.offsetToPos(this.block.contentTo).line;
            const line = Math.min(Math.max(from.line, firstLine), this.closeLine - 1);
            if (line >= firstLine && /<button\b/i.test(editor.getLine(line))) this.rowLine = line;
        }
        this.text = !this.block && !ctx.selection.includes("\n") ? ctx.selection.trim() : "";
    }

    private button(): InlineButton {
        const button: InlineButton = { text: this.text.trim() };
        if (this.action === "disabled") button.disabled = true;
        else if (this.action === "url" && this.url.trim()) button.url = this.url.trim();
        else if (this.action === "copy" && this.copy) button.copy = this.copy;
        if (this.color) button.color = this.color;
        return Object.assign(button, parseButtonEmoji(this.emoji));
    }

    isValid(): boolean {
        const button = this.button();
        return button.text.length > 0 && (button.disabled === true || !!button.url || !!button.copy);
    }

    render(el: HTMLElement, changed: () => void): void {
        this.changed = changed;
        this.previewEl = el.createDiv("telegram-buttons telegram-insert-preview");

        new Setting(el).setName(t.BUTTON_MODAL_TEXT).addText(text => text
            .setPlaceholder(t.BUTTON_MODAL_TEXT_PLACEHOLDER)
            .setValue(this.text)
            .onChange(value => { this.text = value; this.update(); }));

        new Setting(el).setName(t.BUTTON_MODAL_ACTION).addDropdown(dropdown => dropdown
            .addOption("url", t.BUTTON_ACTION_URL)
            .addOption("copy", t.BUTTON_ACTION_COPY)
            .addOption("disabled", t.BUTTON_ACTION_DISABLED)
            .setValue(this.action)
            .onChange(value => {
                this.action = value as ButtonAction;
                this.renderValueSetting();
                this.update();
            }));

        // The link or the text to copy: one field, whose meaning follows the action.
        this.valueSetting = new Setting(el);
        this.renderValueSetting();

        // The colours themselves, as swatches filled the way the button is drawn in each.
        const colorSetting = new Setting(el).setName(t.BUTTON_MODAL_COLOR);
        const swatchesEl = colorSetting.controlEl.createDiv({
            cls: "telegram-color-swatches",
            attr: { role: "radiogroup", "aria-label": t.BUTTON_MODAL_COLOR },
        });
        const swatches: Array<[ButtonColor | "", string, string]> = [
            ["", t.BUTTON_COLOR_DEFAULT, ""],
            ["primary", t.BUTTON_COLOR_BLUE, "mod-blue"],
            ["success", t.BUTTON_COLOR_GREEN, "mod-green"],
            ["danger", t.BUTTON_COLOR_RED, "mod-red"],
        ];
        const swatchEls: HTMLElement[] = [];
        const markSelected = () => swatchEls.forEach((swatchEl, i) => {
            const selected = swatches[i][0] === this.color;
            swatchEl.toggleClass("is-selected", selected);
            swatchEl.setAttr("aria-checked", String(selected));
        });
        for (const [color, label, mod] of swatches) {
            const swatchEl = swatchesEl.createEl("button", {
                cls: ["telegram-color-swatch", mod].filter(Boolean).join(" "),
                attr: { type: "button", role: "radio", "aria-label": label },
            });
            setIcon(swatchEl.createSpan("telegram-color-swatch-check"), "check");
            setTooltip(swatchEl, label);
            swatchEl.addEventListener("click", () => {
                this.color = color;
                markSelected();
                this.update();
            });
            swatchEls.push(swatchEl);
        }
        markSelected();

        new Setting(el)
            .setName(t.BUTTON_MODAL_EMOJI)
            .setDesc(t.BUTTON_MODAL_EMOJI_DESC)
            .addText(text => text
                .setPlaceholder("5368324170671202286")
                .setValue(this.emoji)
                .onChange(value => { this.emoji = value; this.update(); this.loadEmoji(); }));

        if (this.rowLine !== null) {
            new Setting(el)
                .setName(t.BUTTON_MODAL_SAME_ROW)
                .setDesc(t.BUTTON_MODAL_SAME_ROW_DESC)
                .addToggle(toggle => toggle.setValue(this.sameRow).onChange(value => { this.sameRow = value; }));
        }

        this.update();
    }

    private renderValueSetting(): void {
        const setting = this.valueSetting;
        if (!setting) return;
        setting.clear();
        setting.settingEl.toggle(this.action !== "disabled");
        if (this.action === "disabled") return;
        const isUrl = this.action === "url";
        setting.setName(isUrl ? t.BUTTON_MODAL_URL : t.BUTTON_MODAL_COPY).addText(text => text
            .setPlaceholder(isUrl ? "https://example.com" : t.BUTTON_MODAL_COPY_PLACEHOLDER)
            .setValue(isUrl ? this.url : this.copy)
            .onChange(value => {
                if (this.action === "url") this.url = value;
                else this.copy = value;
                this.update();
            }));
    }

    private update(): void {
        if (this.previewEl) {
            const button = this.button();
            this.previewEl.empty();
            const rowEl = this.previewEl.createDiv("telegram-buttons-row");
            renderButton(rowEl, { ...button, text: button.text || t.BUTTON_MODAL_TEXT_PLACEHOLDER });
        }
        this.changed();
    }

    insert(): void {
        const { editor } = this.ctx;
        const html = buttonToHtml(this.button());
        const rowLine = this.rowLine;
        if (this.block && rowLine !== null && this.sameRow) {
            const line = editor.getLine(rowLine);
            editor.replaceRange(` ${html}`, { line: rowLine, ch: line.trimEnd().length }, { line: rowLine, ch: line.length });
        } else if (this.block && rowLine !== null) {
            editor.replaceRange(`\n${html}`, { line: rowLine, ch: editor.getLine(rowLine).length });
        } else if (this.block) {
            // No buttons on the cursor's line: the new row goes just before the closing fence.
            editor.replaceRange(`${html}\n`, { line: this.closeLine, ch: 0 });
        } else {
            insertBlock(editor, `\`\`\`tg-buttons\n${html}\n\`\`\``);
        }
    }

    dispose(): void {
        this.loadEmoji.cancel();
    }
}

// ─── Map ──────────────────────────────────────────────────────────────────────

// A `<tg-map>` block. The location comes from a pasted map link or coordinates, which fill in
// the latitude, longitude and (when the link has one) zoom fields below; those can be edited.
class MapForm implements InsertForm {
    private link = "";
    private lat = "";
    private long = "";
    private zoom = 15;
    private caption = "";
    private changed: () => void = () => {};

    constructor(private readonly ctx: InsertContext) {
        // A link or coordinates selected in the note are read straight away.
        const selected = ctx.selection.trim();
        const point = selected && !selected.includes("\n") ? parseMapInput(selected) : null;
        if (point) this.apply(selected, point);
    }

    private apply(link: string, point: MapPoint): void {
        this.link = link;
        this.lat = String(point.lat);
        this.long = String(point.long);
        if (point.zoom !== undefined) this.zoom = point.zoom;
    }

    private point(): MapPoint | null {
        const lat = parseFloat(this.lat.replace(",", "."));
        const long = parseFloat(this.long.replace(",", "."));
        if (!Number.isFinite(lat) || !Number.isFinite(long) || Math.abs(lat) > 90 || Math.abs(long) > 180) return null;
        return { lat, long, zoom: this.zoom };
    }

    isValid(): boolean {
        return this.point() !== null;
    }

    render(el: HTMLElement, changed: () => void): void {
        this.changed = changed;
        let latInput: HTMLInputElement | null = null;
        let longInput: HTMLInputElement | null = null;
        let zoomSetter: ((value: number) => void) | null = null;

        // A link is long, so the field runs the full width under the description, and what it
        // was read as shows right under the field.
        const linkSetting = stacked(new Setting(el)
            .setName(t.MAP_LINK)
            .setDesc(t.MAP_LINK_DESC));
        const statusEl = linkSetting.settingEl.createDiv("telegram-insert-status");
        const showStatus = (text: string, error: boolean) => {
            statusEl.setText(text);
            statusEl.toggleClass("is-ok", !error);
            statusEl.toggleClass("is-fail", error);
        };
        linkSetting.addText(text => {
            text.inputEl.addClass("telegram-insert-wide");
            text.setPlaceholder("41.9028, 12.4964")
            .setValue(this.link)
            .onChange(value => {
                this.link = value;
                if (!value.trim()) { showStatus("", false); return; }
                if (isShortMapLink(value)) { showStatus(t.MAP_SHORT_LINK, true); return; }
                const point = parseMapInput(value);
                if (!point) { showStatus(t.MAP_NOT_FOUND, true); return; }
                this.apply(value, point);
                if (latInput) latInput.value = this.lat;
                if (longInput) longInput.value = this.long;
                zoomSetter?.(this.zoom);
                showStatus(t.MAP_FOUND.replace("{lat}", this.lat).replace("{long}", this.long), false);
                this.changed();
            });
        });

        new Setting(el).setName(t.MAP_LAT).addText(text => {
            latInput = text.inputEl;
            text.setPlaceholder("41.9028").setValue(this.lat)
                .onChange(value => { this.lat = value; this.changed(); });
        });
        new Setting(el).setName(t.MAP_LONG).addText(text => {
            longInput = text.inputEl;
            text.setPlaceholder("12.4964").setValue(this.long)
                .onChange(value => { this.long = value; this.changed(); });
        });

        new Setting(el).setName(t.MAP_ZOOM).addSlider(slider => {
            slider.setLimits(MAP_ZOOM_MIN, MAP_ZOOM_MAX, 1).setValue(this.zoom)
                .onChange(value => { this.zoom = value; });
            zoomSetter = value => { void slider.setValue(value); };
        });

        new Setting(el).setName(t.MEDIA_CAPTION).addText(text => text
            .setPlaceholder(t.OPTIONAL_PLACEHOLDER)
            .setValue(this.caption)
            .onChange(value => { this.caption = value; }));

        new Setting(el)
            .setName(t.MAP_CHECK)
            .setDesc(t.MAP_CHECK_DESC)
            .addButton(button => button
                .setButtonText(t.MAP_CHECK_BTN)
                .onClick(() => {
                    const point = this.point();
                    if (point) window.open(mapCheckUrl(point));
                    else new Notice(t.MAP_NOT_FOUND);
                }));
    }

    insert(): void {
        const point = this.point();
        if (point) insertBlock(this.ctx.editor, mapToHtml(point, this.caption));
    }
}

// ─── Media ────────────────────────────────────────────────────────────────────

// A picked media item: a vault file, a web link, or a file chosen on this device, which is held
// in memory (with an object URL for a photo's thumbnail) until it's copied into the vault on
// insert — so picking files and then cancelling leaves nothing behind.
type MediaItem =
    | { kind: "vault"; file: TFile }
    | { kind: "web"; url: string }
    | { kind: "device"; file: File; preview: string | null };

type InsertableItem = Exclude<MediaItem, { kind: "device" }>;

const HIDDEN_EXTS = new Set(["md", "canvas", "base"]);

function extOf(name: string): string {
    return /\.(\w+)(?:[?#].*)?$/.exec(name)?.[1]?.toLowerCase() ?? "";
}

function itemName(item: MediaItem): string {
    return item.kind === "web" ? item.url : item.file.name;
}

function itemExt(item: MediaItem): string {
    return item.kind === "vault" ? item.file.extension.toLowerCase() : extOf(itemName(item));
}

// Files a layout can hold: a single media block takes any file Telegram can show (documents
// too), a collage or slideshow only photos and videos. Web links are let through: Telegram
// decides their type by the MIME type as well as the address.
function mediaExtAllowed(ext: string, layout: MediaLayout): boolean {
    if (HIDDEN_EXTS.has(ext)) return false;
    if (layout === "single") return true;
    const kind = richKindForExt(ext);
    return kind === "photo" || kind === "video";
}

function mediaItemAllowed(item: MediaItem, layout: MediaLayout): boolean {
    return item.kind === "web" || mediaExtAllowed(itemExt(item), layout);
}

function releaseItem(item: MediaItem): void {
    if (item.kind === "device" && item.preview) URL.revokeObjectURL(item.preview);
}

class MediaFileSuggest extends AbstractInputSuggest<TFile> {
    constructor(
        app: App,
        inputEl: HTMLInputElement,
        private readonly layout: () => MediaLayout,
        private readonly onPick: (file: TFile) => void,
    ) {
        super(app, inputEl);
        this.limit = 50;
    }

    protected getSuggestions(query: string): TFile[] {
        if (/^https?:\/\//i.test(query.trim())) return [];
        const layout = this.layout();
        const files = this.app.vault.getFiles().filter(file => mediaExtAllowed(file.extension.toLowerCase(), layout));
        if (!query.trim()) return files.sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, this.limit);
        const match = prepareFuzzySearch(query.trim());
        return files
            .map(file => ({ file, result: match(file.path) }))
            .filter((entry): entry is { file: TFile; result: NonNullable<typeof entry.result> } => entry.result !== null)
            .sort((a, b) => b.result.score - a.result.score)
            .map(entry => entry.file);
    }

    renderSuggestion(file: TFile, el: HTMLElement): void {
        el.addClass("telegram-insert-file-suggestion");
        el.createDiv({ text: file.name });
        if (file.parent && !file.parent.isRoot()) el.createDiv({ cls: "telegram-insert-file-path", text: file.parent.path });
    }

    selectSuggestion(file: TFile): void {
        this.onPick(file);
        this.close();
    }
}

// One media block with an optional caption, or a collage or slideshow of several. Items come
// from the vault (with suggestions as you type), from this device's file picker, or are pasted
// web links.
class MediaForm implements InsertForm {
    // The first field is the file field, whose suggestions open on focus and would cover the
    // tab the moment it's shown.
    readonly autofocus = false;
    private layout: MediaLayout;
    private items: MediaItem[] = [];
    private caption = "";
    private addInputEl: HTMLInputElement | null = null;
    private listEl: HTMLElement | null = null;
    private addSetting: Setting | null = null;
    private changed: () => void = () => {};

    constructor(private readonly ctx: InsertContext, layout: MediaLayout = "single") {
        this.layout = layout;
    }

    isValid(): boolean {
        return this.layout === "single" ? this.items.length === 1 : this.items.length >= 2;
    }

    render(el: HTMLElement, changed: () => void): void {
        this.changed = changed;

        new Setting(el).setName(t.MEDIA_LAYOUT).addDropdown(dropdown => dropdown
            .addOption("single", t.MEDIA_LAYOUT_SINGLE)
            .addOption("collage", t.MEDIA_LAYOUT_COLLAGE)
            .addOption("slideshow", t.MEDIA_LAYOUT_SLIDESHOW)
            .setValue(this.layout)
            .onChange(value => {
                this.layout = value as MediaLayout;
                const kept = this.layout === "single"
                    ? this.items.slice(0, 1)
                    : this.items.filter(item => mediaItemAllowed(item, this.layout));
                for (const item of this.items) if (!kept.includes(item)) releaseItem(item);
                this.items = kept;
                this.updateAddSetting();
                this.renderList();
            }));

        this.addSetting = new Setting(el);
        // The system file picker, opened by the folder button. Hidden: it's only there to own
        // the dialog and hand over what was chosen.
        const pickerEl = this.addSetting.controlEl.createEl("input", { attr: { type: "file", hidden: "" } });
        pickerEl.addEventListener("change", () => {
            for (const file of Array.from(pickerEl.files ?? [])) {
                const preview = richKindForExt(extOf(file.name)) === "photo" ? URL.createObjectURL(file) : null;
                this.add({ kind: "device", file, preview });
            }
            pickerEl.value = "";
        });
        this.addSetting
            .addText(text => {
                this.addInputEl = text.inputEl;
                text.setPlaceholder(t.MEDIA_ADD_PLACEHOLDER);
                new MediaFileSuggest(this.ctx.app, text.inputEl, () => this.layout, file => {
                    this.add({ kind: "vault", file });
                    text.setValue("");
                });
            })
            .addExtraButton(button => button
                .setIcon("plus")
                .setTooltip(t.MEDIA_ADD_BTN)
                .onClick(() => this.addFromInput()))
            .addExtraButton(button => button
                .setIcon("folder-open")
                .setTooltip(t.MEDIA_PICK_DEVICE)
                .onClick(() => {
                    pickerEl.multiple = this.layout !== "single";
                    pickerEl.accept = this.layout === "single" ? "" : "image/*,video/*";
                    pickerEl.click();
                }));
        this.updateAddSetting();

        this.listEl = el.createDiv("telegram-insert-media-list");
        this.renderList();

        new Setting(el).setName(t.MEDIA_CAPTION).addText(text => text
            .setPlaceholder(t.OPTIONAL_PLACEHOLDER)
            .setValue(this.caption)
            .onChange(value => { this.caption = value; }));
    }

    private updateAddSetting(): void {
        this.addSetting?.setName(this.layout === "single" ? t.MEDIA_ADD_SINGLE : t.MEDIA_ADD)
            .setDesc(this.layout === "single" ? t.MEDIA_ADD_SINGLE_DESC : t.MEDIA_ADD_GROUP_DESC);
    }

    private add(item: MediaItem): void {
        if (!mediaItemAllowed(item, this.layout)) {
            releaseItem(item);
            new Notice(t.MEDIA_NOT_ALLOWED);
            return;
        }
        // A single media block holds one item: picking another replaces it.
        if (this.layout === "single") {
            this.items.forEach(releaseItem);
            this.items = [item];
        } else {
            this.items.push(item);
        }
        this.renderList();
    }

    // Takes what's typed in the field: a web link, or a vault path when it resolves to a file.
    private addFromInput(): void {
        const input = this.addInputEl;
        const value = input?.value.trim() ?? "";
        if (!input || !value) return;
        if (/^https?:\/\/\S+$/i.test(value)) {
            this.add({ kind: "web", url: value });
        } else {
            const file = this.ctx.app.metadataCache.getFirstLinkpathDest(value, this.ctx.sourcePath);
            if (!file) { new Notice(t.MEDIA_NOT_FOUND); return; }
            this.add({ kind: "vault", file });
        }
        input.value = "";
    }

    handleEnter(target: HTMLElement): boolean {
        if (target !== this.addInputEl || !this.addInputEl?.value.trim()) return false;
        this.addFromInput();
        return true;
    }

    private renderList(): void {
        const listEl = this.listEl;
        if (!listEl) return;
        listEl.empty();
        listEl.toggle(this.items.length > 0);
        // Rows like the saved credentials and proxies: name on the left, icon actions on the right.
        this.items.forEach((item, index) => {
            const rowEl = listEl.createDiv("telegram-insert-media-item");
            const infoEl = rowEl.createDiv("telegram-insert-media-info");
            const thumbEl = infoEl.createDiv("telegram-insert-media-thumb");
            const kind = richKindForExt(itemExt(item));
            const src = item.kind === "vault" ? this.ctx.app.vault.getResourcePath(item.file)
                : item.kind === "web" ? item.url
                : item.preview;
            if (kind === "photo" && src) {
                thumbEl.createEl("img", { cls: "telegram-insert-media-img", attr: { src, alt: "" } });
            } else {
                setIcon(thumbEl, kind === "video" ? "film" : kind === "audio" ? "music" : "file");
            }
            infoEl.createSpan({ cls: "telegram-insert-media-name", text: itemName(item) });
            // Tagged like a saved proxy's type: this one isn't in the vault yet.
            if (item.kind === "device") infoEl.createSpan({ cls: "telegram-insert-media-tag", text: t.MEDIA_FROM_DEVICE });

            const actionsEl = rowEl.createDiv("telegram-insert-media-actions");
            if (this.layout !== "single" && index > 0) {
                new ButtonComponent(actionsEl)
                    .setIcon("arrow-up").setTooltip(t.MEDIA_MOVE_UP)
                    .onClick(() => {
                        [this.items[index - 1], this.items[index]] = [this.items[index], this.items[index - 1]];
                        this.renderList();
                    })
                    .buttonEl.addClass("clickable-icon");
            }
            new ButtonComponent(actionsEl)
                .setIcon("trash").setTooltip(t.MEDIA_REMOVE)
                .onClick(() => {
                    releaseItem(item);
                    this.items.splice(index, 1);
                    this.renderList();
                })
                .buttonEl.addClasses(["clickable-icon", "telegram-danger-icon"]);
        });
        this.changed();
    }

    // Copies a file chosen on this device into the vault, where Obsidian puts attachments for
    // this note (a free name is picked when one is taken), and creates the folder if it's new.
    private async copyToVault(file: File): Promise<TFile> {
        const { app, sourcePath } = this.ctx;
        const path = await app.fileManager.getAvailablePathForAttachment(file.name, sourcePath);
        const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        if (folder && !app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
        return app.vault.createBinary(path, await file.arrayBuffer());
    }

    private embed(item: InsertableItem): string {
        if (item.kind === "vault") return `!${this.ctx.app.fileManager.generateMarkdownLink(item.file, this.ctx.sourcePath)}`;
        return `![](${item.url.replace(/ /g, "%20")})`;
    }

    async insert(): Promise<void> {
        if (!this.isValid()) return;
        // Files from the device go into the vault first; each one copied is swapped in at once,
        // so if a later copy fails, trying again doesn't copy the earlier ones twice.
        for (const [index, item] of this.items.entries()) {
            if (item.kind !== "device") continue;
            let file: TFile;
            try {
                file = await this.copyToVault(item.file);
            } catch (error) {
                throw new Error(t.MEDIA_COPY_FAILED.replace("{name}", item.file.name).replace("{error}", errMessage(error)));
            }
            releaseItem(item);
            this.items[index] = { kind: "vault", file };
        }
        const items = this.items.filter((item): item is InsertableItem => item.kind !== "device");

        let text: string;
        if (this.layout === "single") {
            const item = items[0];
            const target = item.kind === "vault" ? this.ctx.app.metadataCache.fileToLinktext(item.file, this.ctx.sourcePath, false) : item.url;
            text = this.caption.trim() ? captionedEmbed(target, this.caption) : this.embed(item);
        } else {
            text = mediaGroup(this.layout, items.map(item => this.embed(item)), this.caption);
        }
        insertBlock(this.ctx.editor, text);
    }

    dispose(): void {
        this.items.forEach(releaseItem);
    }
}

// ─── Reference ────────────────────────────────────────────────────────────────

class ReferenceNameSuggest extends AbstractInputSuggest<string> {
    constructor(app: App, inputEl: HTMLInputElement, private readonly names: string[], private readonly onPick: (name: string) => void) {
        super(app, inputEl);
    }

    protected getSuggestions(query: string): string[] {
        const q = query.trim().toLowerCase();
        return this.names.filter(name => name.toLowerCase().includes(q));
    }

    renderSuggestion(name: string, el: HTMLElement): void {
        el.setText(name);
    }

    selectSuggestion(name: string): void {
        this.onPick(name);
        this.close();
    }
}

// A link to referenced text and/or the referenced text itself, joined by a shared name. With
// both, the link goes at the cursor and the referenced text at the end of the current post.
class ReferenceForm implements InsertForm {
    private mode: ReferenceMode;
    private name: string;
    private linkText: string;
    private refText = "";
    private readonly names: string[];
    private fieldsEl: HTMLElement | null = null;
    private changed: () => void = () => {};

    constructor(private readonly ctx: InsertContext, mode: ReferenceMode = "both") {
        this.mode = mode;
        const text = ctx.editor.getValue();
        this.names = referenceNames(text);
        // Linking to referenced text that's already written: start from its name.
        this.name = mode === "link" && this.names.length > 0 ? this.names[this.names.length - 1] : nextReferenceName(text);
        const selection = ctx.selection.includes("\n") ? "" : ctx.selection.trim();
        this.linkText = mode === "text" ? "" : selection;
        if (mode === "text") this.refText = selection;
    }

    isValid(): boolean {
        if (!referenceName(this.name)) return false;
        if (this.mode !== "text" && !this.linkText.trim()) return false;
        if (this.mode !== "link" && !this.refText.trim()) return false;
        return true;
    }

    render(el: HTMLElement, changed: () => void): void {
        this.changed = changed;
        new Setting(el).setName(t.REF_MODE).addDropdown(dropdown => dropdown
            .addOption("both", t.REF_MODE_BOTH)
            .addOption("link", t.REF_MODE_LINK)
            .addOption("text", t.REF_MODE_TEXT)
            .setValue(this.mode)
            .onChange(value => {
                this.mode = value as ReferenceMode;
                this.renderFields();
            }));
        this.fieldsEl = el.createDiv();
        this.renderFields();
    }

    private renderFields(): void {
        const el = this.fieldsEl;
        if (!el) return;
        el.empty();
        if (this.mode !== "text") {
            new Setting(el).setName(t.REF_LINK_TEXT).addText(text => text
                .setPlaceholder(t.REF_LINK_TEXT_PLACEHOLDER)
                .setValue(this.linkText)
                .onChange(value => { this.linkText = value; this.changed(); }));
        }
        if (this.mode !== "link") {
            stacked(new Setting(el)
                .setName(t.REF_TEXT)
                .setDesc(this.mode === "both" ? t.REF_TEXT_DESC_BOTH : ""))
                .addTextArea(text => text
                    .setPlaceholder(t.REF_TEXT_PLACEHOLDER)
                    .setValue(this.refText)
                    .onChange(value => { this.refText = value; this.changed(); }));
        }
        new Setting(el)
            .setName(t.REF_NAME)
            .setDesc(t.REF_NAME_DESC)
            .addText(text => {
                text.setValue(this.name).onChange(value => { this.name = value; this.changed(); });
                if (this.names.length > 0) {
                    new ReferenceNameSuggest(this.ctx.app, text.inputEl, this.names, name => {
                        text.setValue(name);
                        this.name = name;
                        this.changed();
                    });
                }
            });
        this.changed();
    }

    insert(): void {
        const { editor } = this.ctx;
        const name = referenceName(this.name);
        const link = referenceLink(name, this.linkText.trim());
        const ref = referenceText(name, this.refText.trim().replace(/\s*\n\s*/g, " "));
        if (this.mode === "link") { editor.replaceSelection(link); return; }
        if (this.mode === "text") { editor.replaceSelection(ref); return; }
        // The referenced text goes first — it's further down, so the cursor's position holds.
        const value = editor.getValue();
        const end = postEndAt(value, editor.posToOffset(editor.getCursor("to")));
        const contentEnd = value.slice(0, end).trimEnd().length;
        editor.replaceRange(`\n\n${ref}`, editor.offsetToPos(contentEnd));
        editor.replaceSelection(link);
    }
}

// ─── Formula ──────────────────────────────────────────────────────────────────

// A LaTeX formula, inline or as a centred block, previewed with Obsidian's own math rendering.
class MathForm implements InsertForm {
    private source: string;
    private display: boolean;
    private previewEl: HTMLElement | null = null;
    private mathReady = false;
    private changed: () => void = () => {};

    constructor(private readonly ctx: InsertContext, display = true) {
        this.display = display;
        this.source = ctx.selection.trim();
    }

    isValid(): boolean {
        return this.source.trim().length > 0;
    }

    render(el: HTMLElement, changed: () => void): void {
        this.changed = changed;
        this.previewEl = el.createDiv("telegram-insert-preview telegram-insert-math-preview");

        stacked(new Setting(el).setName(t.MATH_SOURCE).setDesc(t.MATH_SOURCE_DESC))
            .addTextArea(text => text
                .setPlaceholder("E = mc^2")
                .setValue(this.source)
                .onChange(value => { this.source = value; this.update(); }));

        new Setting(el)
            .setName(t.MATH_DISPLAY)
            .setDesc(t.MATH_DISPLAY_DESC)
            .addToggle(toggle => toggle.setValue(this.display).onChange(value => { this.display = value; this.update(); }));

        void loadMathJax().then(() => { this.mathReady = true; this.update(); });
        this.update();
    }

    private update(): void {
        const el = this.previewEl;
        if (el) {
            el.empty();
            el.toggleClass("is-inline", !this.display);
            const tex = this.source.trim();
            if (!tex) {
                el.createSpan({ cls: "telegram-insert-preview-empty", text: t.MATH_PREVIEW_EMPTY });
            } else if (this.mathReady) {
                el.appendChild(renderMath(tex, this.display));
                void finishRenderMath();
            } else {
                el.setText(tex);
            }
        }
        this.changed();
    }

    insert(): void {
        const text = mathMarkdown(this.source, this.display);
        if (this.display) insertBlock(this.ctx.editor, text);
        else this.ctx.editor.replaceSelection(text);
    }
}

// ─── The window ───────────────────────────────────────────────────────────────

const TABS: Array<{ kind: InsertKind; icon: string; label: () => string; hint: () => string }> = [
    { kind: "button", icon: "mouse-pointer-click", label: () => t.INSERT_TAB_BUTTON, hint: () => t.INSERT_HINT_BUTTON },
    { kind: "map", icon: "navigation", label: () => t.INSERT_TAB_MAP, hint: () => t.INSERT_HINT_RICH },
    { kind: "media", icon: "image", label: () => t.INSERT_TAB_MEDIA, hint: () => t.INSERT_HINT_RICH },
    { kind: "reference", icon: "bookmark", label: () => t.INSERT_TAB_REFERENCE, hint: () => t.INSERT_HINT_RICH },
    { kind: "math", icon: "sigma", label: () => t.INSERT_TAB_MATH, hint: () => t.INSERT_HINT_RICH },
];

export class InsertModal extends Modal {
    private readonly ctx: InsertContext;
    private readonly forms = new Map<InsertKind, InsertForm>();
    private kind: InsertKind;
    private form: InsertForm | null = null;
    private readonly segments = new Map<InsertKind, HTMLElement>();
    private indicatorEl: HTMLElement | null = null;
    private stageInnerEl: HTMLElement | null = null;
    private cardEl: HTMLElement | null = null;
    private insertButton: ButtonComponent | null = null;
    private submitting = false;
    private readonly observers: ResizeObserver[] = [];
    private readonly timers = new Set<number>();

    constructor(
        app: App,
        editor: Editor,
        sourcePath: string,
        previews: () => CustomEmojiThumbnails | null,
        private readonly preset: InsertPreset,
    ) {
        super(app);
        this.ctx = { app, editor, sourcePath, selection: editor.getSelection(), previews };
        this.kind = preset.kind;
    }

    private formFor(kind: InsertKind): InsertForm {
        let form = this.forms.get(kind);
        if (form) return form;
        const preset = kind === this.preset.kind ? this.preset : { kind };
        switch (kind) {
            case "button": form = new ButtonForm(this.ctx); break;
            case "map": form = new MapForm(this.ctx); break;
            case "media": form = new MediaForm(this.ctx, preset.mediaLayout); break;
            case "reference": form = new ReferenceForm(this.ctx, preset.referenceMode); break;
            case "math": form = new MathForm(this.ctx, preset.mathDisplay); break;
        }
        this.forms.set(kind, form);
        return form;
    }

    onOpen(): void {
        const { contentEl, titleEl } = this;
        titleEl.setText(t.INSERT_MODAL_TITLE);
        this.modalEl.addClass("telegram-insert-modal");

        // The element tabs are the segmented bar the settings open with, and each tab's settings
        // a card tucked under it — the same classes, so the two read as one control.
        const barEl = contentEl.createDiv({ cls: "telegram-auth-status is-open" });
        const actionsEl = barEl.createDiv({ cls: "telegram-auth-actions", attr: { role: "tablist" } });
        for (const tab of TABS) {
            const button = new ButtonComponent(actionsEl)
                .setButtonText(tab.label())
                .onClick(() => { if (tab.kind !== this.kind) this.show(tab.kind); });
            button.buttonEl.addClass("telegram-link-button");
            button.buttonEl.setAttr("role", "tab");
            // ButtonComponent's text and icon overwrite each other, so the icon is prepended.
            setIcon(button.buttonEl.createSpan({ cls: "telegram-btn-icon", prepend: true }), tab.icon);
            this.segments.set(tab.kind, button.buttonEl);
        }
        const indicatorEl = barEl.createDiv({ cls: "telegram-auth-indicator" });
        this.indicatorEl = indicatorEl;
        this.observers.push(watchSegments(barEl, actionsEl, [...this.segments.values()], indicatorEl,
            () => this.segments.get(this.kind) ?? null));

        const stageEl = contentEl.createDiv({ cls: "telegram-auth-stage" });
        this.stageInnerEl = stageEl.createDiv({ cls: "telegram-auth-stage-inner" });
        this.observers.push(watchStageHeight(stageEl, this.stageInnerEl));

        const buttonsEl = contentEl.createDiv("telegram-modal-buttons");
        new ButtonComponent(buttonsEl).setButtonText(t.CONFIRM_CANCEL_BTN).onClick(() => this.close());
        this.insertButton = new ButtonComponent(buttonsEl)
            .setButtonText(t.INSERT_MODAL_INSERT)
            .setCta()
            .onClick(() => { void this.submit(); });

        // Enter inserts from a text field. Text areas keep it for new lines, buttons (the tabs,
        // Cancel) for pressing them, and a tab may take it for its own field first.
        this.scope.register([], "Enter", (evt) => {
            const target = evt.target as HTMLElement;
            if (target.tagName === "TEXTAREA" || target.tagName === "BUTTON") return true;
            evt.preventDefault();
            if (!this.form?.handleEnter?.(target)) void this.submit();
            return false;
        });

        this.show(this.kind);
    }

    private show(kind: InsertKind): void {
        this.kind = kind;
        for (const [segmentKind, segmentEl] of this.segments) {
            const active = segmentKind === kind;
            segmentEl.toggleClass("is-active", active);
            segmentEl.setAttr("aria-selected", String(active));
        }
        if (this.indicatorEl) moveSegmentIndicator(this.indicatorEl, this.segments.get(kind) ?? null);

        const innerEl = this.stageInnerEl;
        if (!innerEl) return;
        // Switching tabs hands the space over as the settings' panels do: the old card fades
        // where it stands, out of the flow, while the new one fades up in its place.
        const leaving = this.cardEl;
        if (leaving) {
            leaving.addClasses(["is-leaving", "is-crossfade"]);
            const timer = window.setTimeout(() => { this.timers.delete(timer); leaving.remove(); }, PANEL_EXIT_MS);
            this.timers.add(timer);
        }
        const cardEl = innerEl.createDiv({ cls: "telegram-insert-card" });
        if (leaving) cardEl.addClass("is-switched");
        this.cardEl = cardEl;
        cardEl.createDiv({ cls: "telegram-insert-hint", text: TABS.find(tab => tab.kind === kind)?.hint() ?? "" });

        const bodyEl = cardEl.createDiv({ cls: "telegram-insert-body" });
        this.form = this.formFor(kind);
        this.form.render(bodyEl, () => { this.insertButton?.setDisabled(!this.form?.isValid()); });
        this.insertButton?.setDisabled(!this.form.isValid());

        // Straight into the first field, its text selected so it can be typed over.
        if (this.form.autofocus === false) return;
        window.setTimeout(() => {
            const field = bodyEl.querySelector<HTMLInputElement | HTMLTextAreaElement>("input[type='text'], textarea");
            field?.focus();
            field?.select();
        }, 0);
    }

    // Inserting can take a moment (files from the device are copied into the vault first), so
    // the button stays off until it's done, and a failure keeps the window open to try again.
    private async submit(): Promise<void> {
        const form = this.form;
        if (this.submitting || !form?.isValid()) return;
        this.submitting = true;
        this.insertButton?.setDisabled(true);
        try {
            await form.insert();
            this.close();
            this.ctx.editor.focus();
        } catch (error) {
            new Notice(errMessage(error));
        } finally {
            this.submitting = false;
            this.insertButton?.setDisabled(!this.form?.isValid());
        }
    }

    onClose(): void {
        for (const form of this.forms.values()) form.dispose?.();
        for (const observer of this.observers) observer.disconnect();
        for (const timer of this.timers) window.clearTimeout(timer);
        this.contentEl.empty();
    }
}
