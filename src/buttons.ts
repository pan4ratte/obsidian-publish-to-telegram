// buttons.ts
// Renders a `tg-buttons` code block (see parseButtonRows in markdown.ts) the way Telegram draws
// a post's buttons: rows of equal-width buttons, coloured by their style, with an icon in the
// corner for what the button does. Registered as a code block processor, so the same rendering
// shows in the editor, in reading view and in the publishing preview.

import { App, ButtonComponent, Modal, Setting, debounce, setIcon, setTooltip, type MarkdownPostProcessorContext } from "obsidian";
import { parseButtonEmoji, parseButtonRows, type ButtonColor, type InlineButton } from "./markdown";
import { renderCustomEmoji } from "./emoji-inline";
import { CustomEmojiThumbnails } from "./custom-emoji";
import { t } from "../lang/helpers";

// Telegram's style names → the modifier class styles.css colours a button with.
const COLOR_CLASS: Record<NonNullable<InlineButton["color"]>, string> = {
    danger: "mod-red",
    success: "mod-green",
    primary: "mod-blue",
};

// Emoji ids already asked for this session. A button's id is typed by hand and may not exist
// (or the artwork may be out of reach): the loader caches nothing for those, so without this
// every re-render of the block — opening the note, switching back to it — would go to Telegram
// again, reopening the account connection each time. Artwork that does arrive is drawn into the
// buttons by the loader's subscription (refreshInlineEmoji), whoever asked for it.
const requestedEmoji = new Set<string>();

// Only the drawing: the artwork is requested for the whole block at once by the caller, so
// renderCustomEmoji gets no loader and never asks for it per button.
function renderButton(rowEl: HTMLElement, button: InlineButton): void {
    // A link button is a real link, so it can be opened from the note; the rest do nothing here.
    const el = button.url && !button.disabled
        ? rowEl.createEl("a", { cls: "telegram-button", href: button.url, attr: { target: "_blank", rel: "noopener" } })
        : rowEl.createDiv("telegram-button");
    if (button.color) el.addClass(COLOR_CLASS[button.color]);

    if (button.emojiId) renderCustomEmoji(el.createSpan(), button.emojiFallback ?? "★", button.emojiId, null);
    el.createSpan({ cls: "telegram-button-label", text: button.text });

    if (button.disabled) {
        el.addClass("is-disabled");
    } else if (button.url) {
        setIcon(el.createSpan("telegram-button-kind"), "arrow-up-right");
    } else if (button.copy) {
        setIcon(el.createSpan("telegram-button-kind"), "copy");
        setTooltip(el, t.BUTTON_COPY_TOOLTIP.replace("{text}", button.copy));
    } else {
        // Nothing to do on a tap: publishing refuses it, so the note says so up front.
        el.addClass("is-invalid");
        setTooltip(el, t.BUTTON_NO_ACTION_TOOLTIP);
    }
}

export function buttonsCodeBlockProcessor(previews: () => CustomEmojiThumbnails | null) {
    return (source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext): void => {
        const root = el.createDiv("telegram-buttons");
        const rows = parseButtonRows(source);
        if (rows.length === 0) {
            root.createDiv({ cls: "telegram-buttons-empty", text: t.BUTTONS_EMPTY });
            return;
        }
        for (const row of rows) {
            const rowEl = root.createDiv("telegram-buttons-row");
            for (const button of row) renderButton(rowEl, button);
        }

        requestEmoji(rows.flat(), previews);
    };
}

// One request for every emoji the buttons still lack, and only then is the loader (and with it
// the preview store and, if needed, the account connection) touched at all.
function requestEmoji(buttons: InlineButton[], previews: () => CustomEmojiThumbnails | null): void {
    const missing = [...new Set(buttons.map(button => button.emojiId))]
        .filter((id): id is string => id !== undefined && !CustomEmojiThumbnails.cached(id) && !requestedEmoji.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requestedEmoji.add(id);
    void previews()?.load(missing);
}

// ─── New button modal ─────────────────────────────────────────────────────────

type ButtonAction = "url" | "copy" | "disabled";

// Sets up one button — text, action, colour, emoji — with a live preview drawn by the same
// renderer as the note, then hands it to `onSubmit`. "Same row" is offered only when the button
// can join an existing row (the cursor is on a line of buttons in a `tg-buttons` block).
export class ButtonModal extends Modal {
    private text: string;
    private action: ButtonAction = "url";
    private url = "";
    private copy = "";
    private color: ButtonColor | "" = "";
    private emoji = "";
    private sameRow = false;

    private previewEl!: HTMLElement;
    private valueSetting!: Setting;
    private insertButton: ButtonComponent | null = null;
    // Typing an id fires on every key; ask for the artwork once it has settled.
    private readonly loadEmoji = debounce(() => requestEmoji([this.button()], this.previews), 500, true);

    constructor(
        app: App,
        initialText: string,
        private readonly canJoinRow: boolean,
        private readonly previews: () => CustomEmojiThumbnails | null,
        private readonly onSubmit: (button: InlineButton, sameRow: boolean) => void,
    ) {
        super(app);
        this.text = initialText;
    }

    private button(): InlineButton {
        const button: InlineButton = { text: this.text.trim() };
        if (this.action === "disabled") button.disabled = true;
        else if (this.action === "url" && this.url.trim()) button.url = this.url.trim();
        else if (this.action === "copy" && this.copy) button.copy = this.copy;
        if (this.color) button.color = this.color;
        return Object.assign(button, parseButtonEmoji(this.emoji));
    }

    private isValid(): boolean {
        const button = this.button();
        return button.text.length > 0 && (button.disabled === true || !!button.url || !!button.copy);
    }

    onOpen(): void {
        const { contentEl, titleEl } = this;
        titleEl.setText(t.BUTTON_MODAL_TITLE);
        contentEl.addClass("telegram-button-modal");

        this.previewEl = contentEl.createDiv("telegram-buttons telegram-button-modal-preview");

        new Setting(contentEl).setName(t.BUTTON_MODAL_TEXT).addText(text => {
            text.setPlaceholder(t.BUTTON_MODAL_TEXT_PLACEHOLDER).setValue(this.text)
                .onChange(value => { this.text = value; this.update(); });
            window.setTimeout(() => { text.inputEl.focus(); text.inputEl.select(); }, 0);
        });

        new Setting(contentEl).setName(t.BUTTON_MODAL_ACTION).addDropdown(dropdown => dropdown
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
        this.valueSetting = new Setting(contentEl);
        this.renderValueSetting();

        new Setting(contentEl).setName(t.BUTTON_MODAL_COLOR).addDropdown(dropdown => dropdown
            .addOption("", t.BUTTON_COLOR_DEFAULT)
            .addOption("primary", t.BUTTON_COLOR_BLUE)
            .addOption("success", t.BUTTON_COLOR_GREEN)
            .addOption("danger", t.BUTTON_COLOR_RED)
            .setValue(this.color)
            .onChange(value => { this.color = value as ButtonColor | ""; this.update(); }));

        new Setting(contentEl)
            .setName(t.BUTTON_MODAL_EMOJI)
            .setDesc(t.BUTTON_MODAL_EMOJI_DESC)
            .addText(text => text
                .setPlaceholder("5368324170671202286")
                .setValue(this.emoji)
                .onChange(value => { this.emoji = value; this.update(); this.loadEmoji(); }));

        if (this.canJoinRow) {
            new Setting(contentEl)
                .setName(t.BUTTON_MODAL_SAME_ROW)
                .setDesc(t.BUTTON_MODAL_SAME_ROW_DESC)
                .addToggle(toggle => toggle.setValue(this.sameRow).onChange(value => { this.sameRow = value; }));
        }

        const buttonsEl = contentEl.createDiv("telegram-modal-buttons");
        new ButtonComponent(buttonsEl).setButtonText(t.CONFIRM_CANCEL_BTN).onClick(() => this.close());
        this.insertButton = new ButtonComponent(buttonsEl)
            .setButtonText(t.BUTTON_MODAL_INSERT)
            .setCta()
            .onClick(() => this.submit());

        // Enter inserts, from any field.
        this.scope.register([], "Enter", (evt) => {
            evt.preventDefault();
            this.submit();
            return false;
        });

        this.update();
    }

    private renderValueSetting(): void {
        const setting = this.valueSetting;
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
        const button = this.button();
        this.previewEl.empty();
        const rowEl = this.previewEl.createDiv("telegram-buttons-row");
        renderButton(rowEl, { ...button, text: button.text || t.BUTTON_MODAL_TEXT_PLACEHOLDER });
        this.insertButton?.setDisabled(!this.isValid());
    }

    private submit(): void {
        if (!this.isValid()) return;
        this.onSubmit(this.button(), this.canJoinRow && this.sameRow);
        this.close();
    }

    onClose(): void {
        this.loadEmoji.cancel();
        this.contentEl.empty();
    }
}
