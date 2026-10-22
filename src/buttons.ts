// buttons.ts
// Renders a `tg-buttons` code block (see parseButtonRows in markdown.ts) the way Telegram draws
// a post's buttons: rows of equal-width buttons, coloured by their style, with an icon in the
// corner for what the button does. Registered as a code block processor, so the same rendering
// shows in the editor, in reading view and in the publishing preview.

import { setIcon, setTooltip, type MarkdownPostProcessorContext } from "obsidian";
import { parseButtonRows, type InlineButton } from "./markdown";
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

        // One request for every emoji the block still lacks, and only then is the loader (and
        // with it the preview store and, if needed, the account connection) touched at all.
        const missing = [...new Set(rows.flat().map(button => button.emojiId))]
            .filter((id): id is string => id !== undefined && !CustomEmojiThumbnails.cached(id) && !requestedEmoji.has(id));
        if (missing.length === 0) return;
        for (const id of missing) requestedEmoji.add(id);
        void previews()?.load(missing);
    };
}
