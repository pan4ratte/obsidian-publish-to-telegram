import { App, Modal, Component, ButtonComponent, ToggleComponent, Menu, Notice, TFile, MarkdownRenderer, PluginSettingTab, Setting, TextComponent, DropdownComponent, setIcon, setTooltip, addIcon, getIcon, requestUrl, AbstractInputSuggest } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type { TelegramClient } from "@mtcute/web";
import { t, getUserGuideContent, getChangelogContent } from "../lang/helpers";
import type SendToTelegramPlugin from "../main";
import * as QRCode from "qrcode";
import { TelegramChannel, TelegramSecrets, BotToken, PostMethod, ChatTarget, SplitPartOptions } from "./types";
import { createClient, buildClient, getUserDialogs, DialogData, parseLinkComponents, AUTH_API_ID, AUTH_API_HASH } from "./telegram";
import { parseSplitPosts, linksMatch, type SplitPost } from "./split";
import { stripComments } from "./markdown";
import { getBotInfo } from "./telegram-bot";
import { errMessage, retry, withTimeout } from "./util";

// How long to wait on each network step of revoking a superseded session (connect,
// then log out) before giving up and completing the login regardless.
const REVOKE_TIMEOUT_MS = 8000;

// getMe() identifies the account that just signed in; a transient failure there would
// strand a re-login as a duplicate entry, so it's worth a couple of retries.
const IDENTITY_ATTEMPTS = 3;
const IDENTITY_RETRY_DELAY_MS = 1000;

// Official lucide "link-2-off" path data (24×24, scaled to Obsidian's 100×100 icon
// viewBox). Registered on demand because Obsidian's bundled lucide set lacks this icon.
const LINK_2_OFF_ICON = `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="scale(4.1667)"><path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><line x1="8" y1="12" x2="12" y2="12"/><line x1="2" y1="2" x2="22" y2="22"/></g>`;

// Official lucide "ban" path data, same 24×24 → 100×100 scaling. Registered on demand
// for the same reason as link-2-off: it may be missing from Obsidian's bundled set.
const BAN_ICON = `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="scale(4.1667)"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></g>`;

// ─── Long-press tooltips (touch) ──────────────────────────────────────────────

// How long a touch has to be held before the control explains itself.
const LONG_PRESS_MS = 450;

// Obsidian shows tooltips on hover, which a touch screen never produces — so on a phone or
// tablet the icon-only controls in the advanced modal have no way to say what they do. This
// shows the element's tooltip after a long press instead, and swallows the tap that ends the
// press so reading a control doesn't also toggle it.
//
// The text is read from `aria-label` at press time (that's where setTooltip puts it), so a
// control whose tooltip changes with its state always shows its current one. The popup carries
// its own class instead of Obsidian's `.tooltip` — the mobile app suppresses those, hover being
// impossible there — and styles.css gives it the same look.
//
// Must be called BEFORE the element's own click listener: at the target, listeners run in the
// order they were added regardless of the capture flag, and the guard below has to run first
// to be able to stop the rest.
function enableLongPressTooltip(el: HTMLElement): void {
    let timer: number | null = null;
    let fired = false;
    let tooltipEl: HTMLElement | null = null;

    const cancel = () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = null;
        tooltipEl?.remove();
        tooltipEl = null;
    };

    const show = () => {
        const text = el.getAttribute("aria-label");
        if (!text) return;
        fired = true;
        const rect = el.getBoundingClientRect();
        tooltipEl = document.body.createDiv({ cls: "telegram-touch-tooltip", text });
        // Centred above the control and clamped to the viewport, so a control at either edge
        // of the row still shows its tooltip in full.
        const centered = rect.left + rect.width / 2 - tooltipEl.offsetWidth / 2;
        const left = Math.min(Math.max(centered, 8), window.innerWidth - tooltipEl.offsetWidth - 8);
        tooltipEl.style.left = `${Math.max(left, 8)}px`;
        tooltipEl.style.top = `${Math.max(rect.top - tooltipEl.offsetHeight - 8, 8)}px`;
    };

    // The tap that ends a long press is cancelled twice over: preventDefault on touchend stops
    // the synthetic click on platforms that derive it from the touch sequence, and the guard
    // below stops it everywhere else. stopImmediatePropagation is what keeps the element's own
    // click handler from running — stopPropagation alone wouldn't.
    el.addEventListener("click", (evt: MouseEvent) => {
        if (!fired) return;
        fired = false;
        evt.preventDefault();
        evt.stopImmediatePropagation();
    }, { capture: true });
    el.addEventListener("touchstart", () => {
        fired = false;
        cancel();
        timer = window.setTimeout(show, LONG_PRESS_MS);
    }, { passive: true });
    el.addEventListener("touchmove", cancel, { passive: true });
    el.addEventListener("touchend", (evt: TouchEvent) => {
        if (fired) evt.preventDefault();
        cancel();
    }, { passive: false });
    el.addEventListener("touchcancel", cancel, { passive: true });
}

// Wraps an async handler so it can be used where a void-returning callback is
// expected (e.g. addEventListener); the returned promise is explicitly discarded.
function voidListener<E extends Event = Event>(handler: (evt: E) => Promise<void>): (evt: E) => void {
    return (evt: E) => { void handler(evt); };
}

// ─── Channel resolution helpers ───────────────────────────────────────────────

// Resolves the display title and entity type of any Telegram chat from its link.
// isChannel is true for broadcast channels, false for groups (including discussion groups).
async function fetchEntityInfo(link: string, secrets?: TelegramSecrets): Promise<{ title: string | null; isChannel: boolean } | null> {
    const parsed = parseLinkComponents(link);
    if (!parsed || !secrets?.telegramSession) return null;
    const entity: string | number = /^-?\d+$/.test(parsed.chatId) ? parseInt(parsed.chatId) : parsed.chatId;
    const client = await createClient(secrets.telegramSession, secrets.telegramApiId, secrets.telegramApiHash);
    try {
        // getPeer (not getChat) so personal chats resolve too: getChat throws for user peers
        // (DMs, Saved Messages, bots), which is why editing a post in personal messages failed
        // with "Could not resolve this link". getPeer routes users → getUser, chats → getChat.
        const chat = await client.getPeer(entity);
        let title = chat.displayName || (chat.username ? `@${chat.username}` : null);
        const isChannel = "chatType" in chat && chat.chatType === "channel";
        // For a forum-topic post, append the topic name so the target reads e.g. "Group: Topic".
        if (title && parsed.topicId) {
            try {
                const [topic] = await client.getForumTopicsById(entity, parsed.topicId);
                if (topic?.title) title = `${title}: ${topic.title}`;
            } catch { /* topic name unavailable — keep the chat title alone */ }
        }
        return { title, isChannel };
    } catch {
        return null;
    } finally {
        await client.destroy();
    }
}

// Resolves a link's chat info by trying each authorized account in turn. The account that
// published a stored link isn't necessarily the primary one, and an account can only read a
// chat it belongs to — so when one account can't access the chat, the remaining accounts are
// tried. Returns the first successful lookup, or null when no account can resolve it.
async function fetchEntityInfoAnyAccount(link: string, plugin: SendToTelegramPlugin): Promise<{ title: string | null; isChannel: boolean } | null> {
    for (const account of plugin.settings.accounts) {
        const secrets = plugin.getAccountSecrets(account.id);
        if (!secrets.telegramSession) continue;
        const info = await fetchEntityInfo(link, secrets);
        if (info) return info;
    }
    return null;
}

// The selectable posting methods with their localized labels, in display order.
function methodOptions(): Array<[PostMethod, string]> {
    return [
        ["account", t.METHOD_ACCOUNT],
        ["account-rich", t.METHOD_ACCOUNT_RICH],
        ["bot", t.METHOD_BOT],
        ["bot-rich", t.METHOD_BOT_RICH],
    ];
}

// True for the account (User API) method family, which posts as a user account.
function isAccountMethod(method: PostMethod): boolean {
    return method === "account" || method === "account-rich";
}

// True for the Rich Message variants (posts rich text): "account-rich" from a user
// account (needs Telegram Premium), "bot-rich" from a bot.
function isRichMethod(method: PostMethod): boolean {
    return method === "account-rich" || method === "bot-rich";
}

// What a previewed message does on publish, picked with the mode toggle under its preview.
type SplitMode = "ignore" | "publish" | "edit";

// The settings a comment card can inherit from the post card it belongs to ("Comments follow
// post settings") — everything a reply can carry. Not among them: the scheduled date, which a
// comment has no use for (it goes out with its post), and the chosen link-preview URL, which is
// picked by clicking a link inside one message's own text and means nothing in another's.
type SharedSetting = "silent" | "preview" | "attach" | "online";

// One previewed message in the advanced modal: a post part, or one of the pre-written comments
// (embedded .md notes) that ride along with it. Both get the same settings row and mode toggle;
// a comment publishes as a text reply, so the options a reply can't carry (attachment
// positioning, scheduling) are permanently blocked on comment cards.
interface CardRow {
    kind: "post" | "comment";
    // What this message does on publish: "ignore" skips it, "publish" sends it as a new
    // message, "edit" rewrites an already-published one (editLink, chosen from editLinks —
    // "all" edits every link at once, null means the user still has to choose).
    mode: SplitMode;
    editLinks: string[];
    editLink: string | null;
    applyMode: () => void;
    silentOn: boolean;
    attachOn: boolean;
    previewMode: "default" | "top" | "off";
    linkPreviewUrl: string | null;
    updateLinkPreviewCard: () => void;
    onlineOn: boolean;
    scheduleValue: string;
    // Method-conflict flags + visual re-appliers. A blocked control LOOKS reset (no active
    // state, empty date) so the user isn't misled, but the underlying state survives and
    // reappears when a supported method is picked again. `ignoreBlocked` is the same idea for
    // a message set to "ignore": it isn't sent at all, so none of its settings apply.
    richBlocked: boolean;
    schedBlocked: boolean;
    editBlocked: boolean;
    ignoreBlocked: boolean;
    // Comment cards: the settings the user has set on this comment itself, which therefore stop
    // following the post's ("Comments follow post settings").
    overrides: Set<SharedSetting>;
    applyRichState: () => void;
    applySchedState: () => void;
    applyModeState: () => void;
    // Comment cards: the comment's position among the whole note's comment notes, which is how
    // an edit targets exactly this comment (editNoteComments' embedOffset). -1 on post cards.
    embedIndex: number;
    // Post cards: the comment cards nested under this part, in publish order.
    comments: CardRow[];
}

// The mode toggle's segments, in display order, with their lucide icon and label. Only the
// modes a given post actually offers are rendered (see modeOptionsFor).
function splitModeSegments(): Array<[SplitMode, string, string]> {
    return [
        ["ignore", "ban", t.MULTI_PRESET_SPLIT_MODE_IGNORE],
        ["publish", "send", t.MULTI_PRESET_SPLIT_MODE_PUBLISH],
        ["edit", "pencil", t.MULTI_PRESET_SPLIT_MODE_EDIT],
    ];
}

// The posting methods a preset offers in the advanced modal: its primary method's
// family ("account" + "account-rich", or "bot" + "bot-rich") is always available; the
// opposite family is added only when the preset has "Use secondary publication methods".
function availableMethods(channel: TelegramChannel): Set<PostMethod> {
    const primaryIsAccount = isAccountMethod(channel.defaultMethod ?? "account");
    const accountFamily: PostMethod[] = ["account", "account-rich"];
    const botFamily: PostMethod[] = ["bot", "bot-rich"];
    const primary = primaryIsAccount ? accountFamily : botFamily;
    if (!channel.useSecondaryMethods) return new Set(primary);
    return new Set([...primary, ...(primaryIsAccount ? botFamily : accountFamily)]);
}

// Normalizes a chat id (preset target or a link's parsed chat) for comparison so
// "@Channel", "channel" and a -100… id compare consistently.
function normChatId(id: string): string {
    return id.trim().toLowerCase().replace(/^@/, "");
}

// Builds a minimal TelegramChannel from a link's parsed chat ID (no preset needed).
function channelFromLink(link: string, name: string): TelegramChannel | null {
    const parsed = parseLinkComponents(link);
    if (!parsed) return null;
    return {
        id: "update-temp",
        name,
        defaultMethod: "account",
        chatId: parsed.chatId,
        chatTargets: [{ id: parsed.chatId, title: name }],
        isDefault: false,
    };
}

// ─── Formatting Help Modal ────────────────────────────────────────────────────

export class FormattingHelpModal extends Modal {

    // Scoped to the modal lifecycle so MarkdownRenderer's child components are
    // cleaned up on close — Modal isn't a Component, and the plugin instance
    // lives too long to use here.
    private readonly renderComponent = new Component();
    private readonly content: string;

    constructor(app: App, content: string) {
        super(app);
        this.content = content;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText(t.SETTING_FORMATTING_HELP);
        contentEl.addClass("telegram-formatting-help-modal");
        this.renderComponent.load();
        void MarkdownRenderer.render(
            this.app,
            this.content,
            contentEl,
            "",
            this.renderComponent
        );
        contentEl.addEventListener("click", (e) => {
            const link = (e.target as HTMLElement).closest("a");
            if (!link) return;
            let url: URL;
            try { url = new URL(link.href); } catch { return; }
            if (url.protocol !== "obsidian:") return;
            if (url.hostname !== "command") return;
            e.preventDefault();
            e.stopPropagation();
            const id = url.searchParams.get("id");
            if (id) (this.app as unknown as { commands: { executeCommandById(id: string): void } }).commands.executeCommandById(id);
        }, { capture: true });
    }

    onClose() {
        this.renderComponent.unload();
        this.contentEl.empty();
    }
}

// ─── Changelog Modal ─────────────────────────────────────────────────────────

export class ChangelogModal extends Modal {
    private readonly content: string;
    private readonly renderComponent = new Component();

    constructor(app: App, content: string) {
        super(app);
        this.content = content;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass("telegram-changelog-modal");
        this.renderComponent.load();
        void MarkdownRenderer.render(this.app, this.content, contentEl, "", this.renderComponent);
    }

    onClose() {
        this.renderComponent.unload();
        this.contentEl.empty();
    }
}

// ─── Confirmation Modal ───────────────────────────────────────────────────────

class ConfirmationModal extends Modal {
    onSubmit: () => void | Promise<void>;
    title: string;
    message: string;
    confirmText: string;

    constructor(app: App, title: string, message: string, confirmText: string, onSubmit: () => void | Promise<void>) {
        super(app);
        this.title = title;
        this.message = message;
        this.confirmText = confirmText;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText(this.title);
        contentEl.createEl("p", { text: this.message });
        const btnContainer = contentEl.createDiv("telegram-modal-buttons");
        new ButtonComponent(btnContainer).setButtonText(t.CONFIRM_CANCEL_BTN).onClick(() => this.close());
        new ButtonComponent(btnContainer).setButtonText(this.confirmText).setWarning().onClick(() => {
            void this.onSubmit();
            this.close();
        });
    }

    onClose() { this.contentEl.empty(); }
}


// ─── Multi Preset Modal ───────────────────────────────────────────────────────

export class MultiPresetModal extends Modal {
    plugin: SendToTelegramPlugin;
    selectedChannels: Set<string>;
    file: TFile;
    private initialChannelId?: string;

    // Guards programmatic preset-toggle changes so radio-style selection (only one
    // preset at a time) doesn't re-enter the toggle's own onChange handler.
    private updatingPresets = false;

    private channelRows: Array<{ id: string, container: HTMLElement, toggle: ToggleComponent, method: PostMethod, methodsEl: HTMLElement }> = [];
    private resolvedLinks = new Map<string, { title: string | null; isChannel: boolean }>();
    // Post links recorded in the note's `tg_posts` property; they're what a single-post note
    // offers for editing (a split note edits through its own per-part markers instead).
    private storedPostLinks: string[] = [];
    // Comment links recorded in `tg_comments`. Each comment card takes its own link(s) from
    // here by position — see commentEditLinks.
    private storedCommentLinks: string[] = [];
    // Paths of the note's pre-written comment notes in whole-note collection order. A comment's
    // position here is the `embedOffset` that targets exactly that comment on an edit.
    private commentEmbedOrder: string[] = [];
    // Resolves every stored link's chat title once per modal. The edit pickers are usable
    // before it settles, so the publish handler awaits it before editing anything.
    private linkResolution: Promise<void> = Promise.resolve();

    // ── Message previews ─────────────────────────────────────────────────────────
    // Every publish shows the note as the messages it will produce: each part (one for a
    // plain note, several for a `%% \split %%` note) and each of its pre-written comments
    // gets its own settings button row, rendered preview and mode toggle.
    private splitPosts: SplitPost[] = [];
    // One card per part, index-aligned to parseSplitPosts order; each carries its comment
    // cards in publish order.
    private splitRows: CardRow[] = [];
    // Scoped to the modal lifecycle so the preview MarkdownRenderer children unload on close.
    private readonly splitRenderComponent = new Component();
    // OpenGraph data for chosen link-preview sources, fetched once per URL per modal.
    private linkPreviewCache = new Map<string, Promise<{ siteName: string; title?: string; description?: string; image?: string }>>();

    // ── Ad-hoc (preset-less) publishing ──────────────────────────────────────────
    // Lets the user publish once by picking targets + an author + a method directly in
    // this modal, without a saved preset. Mirrors the preset chat-target picker.
    private adhocTargets: ChatTarget[] = [];
    private adhocAuthor: { type: "account" | "bot"; id: string } | null = null;
    private adhocMethod: PostMethod | null = null;
    private adhocMethodDropdown: DropdownComponent | null = null;
    private adhocPickerFieldEl: HTMLElement | null = null;
    private adhocActiveSuggest: ChatSuggest | null = null;
    // Creates the chat suggest on first use and opens the list. Set by renderAdhocPickerField
    // (null when there's no account to suggest from). Called only from real user gestures —
    // see the lazy-creation note there.
    private adhocActivatePicker: (() => void) | null = null;
    // Set by the first pointer/key event inside the modal. Obsidian focuses the modal's first
    // focusable element on open — the ad-hoc search field — and a caret blinking there is
    // confusing, so a focus that arrives before any user gesture is bounced. Gesture-based
    // rather than time-based so it holds whenever Obsidian's autofocus happens to run.
    private adhocUserInteracted = false;
    // One dialog fetch per account for the modal's lifetime (chat-picker suggestions).
    private dialogsByAccount = new Map<string, { fetch: Promise<DialogData[]>; loading: boolean }>();

    constructor(app: App, plugin: SendToTelegramPlugin, file: TFile, initialChannelId?: string) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.selectedChannels = new Set();
        this.initialChannelId = initialChannelId;
    }

    // Every previewed message — post parts and their comments alike. All the option-state
    // updaters work on this flat view; publishing walks the parts and their comments instead.
    private allCards(): CardRow[] {
        return this.splitRows.flatMap(row => [row, ...row.comments]);
    }

    // The messages set to edit an already-published message, and the ones set to publish as a
    // new message. Both come from the per-message mode toggles.
    private editingRows(): CardRow[] { return this.allCards().filter(row => row.mode === "edit"); }
    private publishingRows(): CardRow[] { return this.allCards().filter(row => row.mode === "publish"); }

    // The methods that would actually be used on publish: one per selected preset plus the
    // ad-hoc method (when chosen). Drives which advanced options apply.
    private activeMethods(): PostMethod[] {
        const methods = this.channelRows.filter(r => this.selectedChannels.has(r.id)).map(r => r.method);
        if (this.adhocMethod) methods.push(this.adhocMethod);
        return methods;
    }

    // Scheduling and "send when online" aren't supported by the Bot API, and neither editing an
    // existing post nor ignoring a message can use either. The controls grey out and visually
    // reset, but the stored state survives — switching back to a supported method restores it.
    private updateScheduleState() {
        const methods = this.activeMethods();
        const allBot = methods.length > 0 && methods.every(m => !isAccountMethod(m));
        for (const row of this.allCards()) {
            row.schedBlocked = allBot || row.mode !== "publish";
            row.applySchedState();
        }
    }

    // Hands a setting the user just changed on a post card to that post's comments, for
    // "Comments follow post settings". A change made on a comment card instead is that comment
    // opting out: it records the override and from then on keeps its own value for that setting.
    private shareSetting(row: CardRow, setting: SharedSetting) {
        if (row.kind === "comment") { row.overrides.add(setting); return; }
        if (!this.plugin.settings.commentsFollowPostSettings) return;
        for (const comment of row.comments) {
            if (comment.overrides.has(setting)) continue;
            if (setting === "silent") comment.silentOn = row.silentOn;
            else if (setting === "preview") comment.previewMode = row.previewMode;
            else if (setting === "attach") comment.attachOn = row.attachOn;
            else comment.onlineOn = row.onlineOn;
            // Repaints the whole settings row from the card's state, the shared setting included.
            comment.applyModeState();
            comment.applySchedState();
        }
    }

    // Rich Messages support neither caption positioning nor a message-level link
    // preview. The buttons grey out and visually reset, but their state survives —
    // switching back to a supported method restores the user's choices.
    private updateAttachState() {
        const anyRich = this.activeMethods().some(isRichMethod);
        for (const row of this.allCards()) {
            row.richBlocked = anyRich;
            row.applyRichState();
        }
    }

    // Per message: the options its mode can't use grey out and visually reset, state preserved.
    // On a card set to "edit" that's silent and the link-preview mode (scheduling is covered by
    // updateScheduleState); attachment positioning stays enabled, it's the one option edits
    // support. A card set to "ignore" sends nothing at all, so every option is blocked.
    private updateModeState() {
        for (const row of this.allCards()) {
            row.editBlocked = row.mode === "edit";
            row.ignoreBlocked = row.mode === "ignore";
            row.applyModeState();
        }
    }

    // Selects a single preset (or none), enforcing radio-style behaviour: turning one on
    // turns every other one off. Updates each row's toggle and method-picker visibility,
    // then refreshes the option states that depend on the chosen method.
    private selectOnlyPreset(id: string | null) {
        this.updatingPresets = true;
        this.selectedChannels.clear();
        if (id) this.selectedChannels.add(id);
        for (const r of this.channelRows) {
            const on = r.id === id;
            r.toggle.setValue(on);
            r.methodsEl.toggleClass("is-hidden", !on);
        }
        this.updatingPresets = false;
        this.updateScheduleState();
        this.updateAttachState();
    }

    // A chosen edit target names a chat, and the preset covering that chat is the one that will
    // route the edit (editRouteFor) — so when exactly one preset can reach the chats being
    // edited, it's picked automatically. Only ever fills an empty selection: an explicit choice
    // (including one made by the command that opened the modal) is never overridden.
    private autoSelectPresetForEdit() {
        if (this.selectedChannels.size > 0 || this.adhocAuthor !== null) return;

        const chatIds = new Set<string>();
        for (const row of this.editingRows()) {
            const links = row.editLink === "all" ? row.editLinks : row.editLink ? [row.editLink] : [];
            for (const link of links) {
                const parsed = parseLinkComponents(link);
                if (parsed) chatIds.add(normChatId(parsed.chatId));
            }
        }
        if (chatIds.size === 0) return;

        const matching = this.channelRows.filter(row => {
            const channel = this.plugin.settings.channels.find(c => c.id === row.id);
            return !!channel && (channel.chatTargets ?? []).some(target => chatIds.has(normChatId(target.id)));
        });
        // Several candidates (or none) leave the choice to the user — guessing would be wrong
        // as often as it was right.
        if (matching.length === 1) this.selectOnlyPreset(matching[0].id);
    }

    // Re-applies everything that depends on the current modes and the chosen preset — most
    // per-message options don't apply to an edit.
    //
    // Editing used to narrow the preset list to the presets whose chats matched the link being
    // edited, untoggling any that didn't. That belonged to the old single-dropdown model: one
    // action can now edit several messages in different chats while publishing others, so
    // there's no single chat to filter by. Instead the single unambiguous case is handled for
    // the user (autoSelectPresetForEdit), and routing still prefers a selected preset covering
    // the link's chat, falling back to the account.
    private refreshOptionStates() {
        // Modes first: the mode-derived flags are what the method-driven updaters below
        // mix into each control's disabled state.
        this.updateModeState();
        this.updateScheduleState();
        this.updateAttachState();
    }

    // The first selected preset whose chat targets include the given chat, with the
    // method chosen for it. Drives how an edit is routed: its method picks account vs.
    // classic-bot vs. rich-bot editing, and (for bot methods) its token is used.
    private editRouteFor(chatId: string): { channel: TelegramChannel; method: PostMethod } | null {
        for (const row of this.channelRows) {
            if (!this.selectedChannels.has(row.id)) continue;
            const channel = this.plugin.settings.channels.find(c => c.id === row.id);
            if (channel && (channel.chatTargets ?? []).some(target => normChatId(target.id) === normChatId(chatId))) {
                return { channel, method: row.method };
            }
        }
        return null;
    }

    // Edits a single stored post link, routing by the matched preset's method so the edit
    // preserves it: bot / bot-rich edit via the bot, account / account-rich via the user
    // account (keeping rich formatting for the "-rich" variants). With no matching preset
    // it falls back to the account path (channelFromLink), which needs the chat resolved.
    private async editPost(link: string, title: string | null, silent: boolean, attachUnderText: boolean): Promise<void> {
        const parsed = parseLinkComponents(link);
        const route = parsed ? this.editRouteFor(parsed.chatId) : null;
        if (parsed && route) {
            const editChannel: TelegramChannel = {
                ...route.channel,
                chatId: parsed.chatId,
                chatTargets: [{ id: parsed.chatId, title: title ?? parsed.chatId }],
            };
            await this.plugin.sendNoteToTelegram(this.file, editChannel, silent, attachUnderText, link, undefined, route.method);
            return;
        }
        const channel = title ? channelFromLink(link, title) : null;
        if (channel) {
            await this.plugin.sendNoteToTelegram(this.file, channel, silent, attachUnderText, link, undefined);
            return;
        }
        // Neither a selected preset nor an authorized account can reach this chat — say so
        // rather than finishing quietly with nothing edited.
        new Notice(t.MULTI_PRESET_UPDATE_NO_MATCH);
    }

    // Edits one pre-written comment in place. `embedIndex` is the comment's position among the
    // note's comment notes, which is how the send paths line a stored link up with the note
    // whose content it holds. Routes like a post edit: the selected preset's method and token
    // when one covers the comment's chat, else the account path.
    private async editComment(link: string, embedIndex: number, silent: boolean): Promise<void> {
        const parsed = parseLinkComponents(link);
        if (!parsed) return;
        const route = this.editRouteFor(parsed.chatId);
        await this.plugin.editNoteComments(this.file, [link], silent, route?.method ?? "account", route?.channel.botToken, embedIndex);
    }

    // The stored links that a comment card can edit: `tg_comments` holds every comment link of
    // the note, so they're grouped by chat and ordered within each chat, and the comment at
    // position `embedIndex` takes that position from each chat's group — one link per chat the
    // note was published to.
    private commentEditLinks(embedIndex: number): string[] {
        const groups = new Map<string, string[]>();
        for (const link of this.storedCommentLinks) {
            const parsed = parseLinkComponents(link);
            if (!parsed) continue;
            const group = groups.get(normChatId(parsed.chatId)) ?? [];
            group.push(link);
            groups.set(normChatId(parsed.chatId), group);
        }
        const links: string[] = [];
        for (const group of groups.values()) {
            group.sort((a, b) => (parseLinkComponents(a)?.messageId ?? 0) - (parseLinkComponents(b)?.messageId ?? 0));
            if (group[embedIndex]) links.push(group[embedIndex]);
        }
        return links;
    }

    // Builds the "Post without a preset" section: a chat-target picker plus author/method
    // dropdowns, letting the user publish once without a saved preset.
    private renderAdhocSection(container: HTMLElement): void {
        // A real user gesture anywhere in the modal releases the open-time focus guard.
        const markInteraction = () => { this.adhocUserInteracted = true; };
        this.contentEl.addEventListener("pointerdown", markInteraction, { capture: true });
        this.contentEl.addEventListener("keydown", markInteraction, { capture: true });

        container.createDiv({ text: t.MULTI_PRESET_ADHOC_HEADING, cls: "telegram-modal-heading" });
        // Bordered box matching the other sections in this modal.
        const boxEl = container.createDiv("telegram-adhoc-box");

        // Chat-target picker (chips + always-visible search / manual-entry input).
        const pickerEl = boxEl.createDiv("telegram-chat-picker");
        const fieldEl = pickerEl.createDiv("telegram-chat-picker-field");
        this.adhocPickerFieldEl = fieldEl;
        fieldEl.addEventListener("click", (e: MouseEvent) => {
            if ((e.target as HTMLElement).closest(".telegram-chat-chip-remove")) return;
            fieldEl.querySelector<HTMLInputElement>(".telegram-chat-search")?.focus();
            // Clicking the field is the gesture that loads chats and opens the suggestion list.
            this.adhocActivatePicker?.();
        });
        this.renderAdhocPickerField();

        // Author + method dropdowns, side by side.
        const selectorsEl = boxEl.createDiv("telegram-adhoc-selectors");

        const authorDropdown = new DropdownComponent(selectorsEl.createDiv("telegram-adhoc-select"));
        authorDropdown.addOption("", t.MULTI_PRESET_ADHOC_AUTHOR_PLACEHOLDER);
        for (const account of this.plugin.settings.accounts) {
            authorDropdown.addOption(`account:${account.id}`, account.displayName || t.METHOD_ACCOUNT);
        }
        for (const bot of this.plugin.settings.botTokens) {
            authorDropdown.addOption(`bot:${bot.id}`, bot.name);
        }
        authorDropdown.setValue("");

        const methodDropdown = new DropdownComponent(selectorsEl.createDiv("telegram-adhoc-select"));
        this.adhocMethodDropdown = methodDropdown;
        this.resetAdhocMethodDropdown();

        authorDropdown.onChange(value => {
            this.adhocAuthor = value ? this.parseAdhocAuthor(value) : null;
            this.adhocMethod = null;
            // The method options depend on the author kind; suggestions come from the account
            // (bots can't list dialogs), so rebuild both the method dropdown and the picker.
            this.resetAdhocMethodDropdown();
            this.renderAdhocPickerField();
            this.updateScheduleState();
            this.updateAttachState();
        });

        methodDropdown.onChange(value => {
            this.adhocMethod = value ? (value as PostMethod) : null;
            this.updateScheduleState();
            this.updateAttachState();
        });
    }

    private parseAdhocAuthor(value: string): { type: "account" | "bot"; id: string } {
        const sep = value.indexOf(":");
        const type = value.slice(0, sep);
        return { type: type === "bot" ? "bot" : "account", id: value.slice(sep + 1) };
    }

    // Repopulates the method dropdown for the current author: an account offers the account
    // methods, a bot the bot methods. Stays disabled (and reset) until an author is chosen.
    private resetAdhocMethodDropdown(): void {
        const dropdown = this.adhocMethodDropdown;
        if (!dropdown) return;
        dropdown.selectEl.empty();
        dropdown.addOption("", t.MULTI_PRESET_ADHOC_METHOD_PLACEHOLDER);
        if (this.adhocAuthor) {
            const family: PostMethod[] = this.adhocAuthor.type === "bot"
                ? ["bot", "bot-rich"] : ["account", "account-rich"];
            for (const [value, label] of methodOptions()) {
                if (family.includes(value)) dropdown.addOption(value, label);
            }
        }
        dropdown.setValue("");
        dropdown.setDisabled(!this.adhocAuthor);
    }

    // Rebuilds the ad-hoc chat-target field (chips + input). Called on every target change and
    // when the author switches (its account, if any, is the source of chat suggestions).
    private renderAdhocPickerField(): void {
        const fieldEl = this.adhocPickerFieldEl;
        if (!fieldEl) return;
        this.adhocActiveSuggest?.close();
        this.adhocActiveSuggest = null;
        fieldEl.empty();

        for (const target of this.adhocTargets) {
            const chip = fieldEl.createSpan({ cls: "telegram-chat-chip" });
            chip.createSpan({ text: target.title || target.id, cls: "telegram-chat-chip-text" });
            const removeBtn = chip.createEl("button", { cls: "telegram-chat-chip-remove" });
            setIcon(removeBtn, "x");
            removeBtn.addEventListener("mouseenter", () => chip.classList.add("remove-hover"));
            removeBtn.addEventListener("mouseleave", () => chip.classList.remove("remove-hover"));
            removeBtn.addEventListener("click", (e: MouseEvent) => {
                e.stopPropagation();
                this.adhocTargets = this.adhocTargets.filter(x => !(x.id === target.id && x.topicId === target.topicId));
                this.renderAdhocPickerField();
            });
        }

        const input = fieldEl.createEl("input", { cls: "telegram-chat-search" });
        input.type = "text";
        const hasChips = this.adhocTargets.length > 0;
        fieldEl.classList.toggle("has-chips", hasChips);

        // Bounce Obsidian's open-time autofocus so the modal opens with no caret in the field.
        // A click or Tab always fires its pointerdown/keydown first, so real focus gets through.
        input.addEventListener("focus", () => {
            if (!this.adhocUserInteracted) input.blur();
        });

        // Suggestions load from the chosen account. When no account author is picked, fall back
        // to the sole authorized account (if there's exactly one) purely to load chats — this
        // does NOT select it as the post author. With several accounts and no author chosen,
        // there's no unambiguous source, so only manual @username/ID entry is offered.
        const soleAccountId = this.plugin.settings.accounts.length === 1
            ? this.plugin.settings.accounts[0].id : undefined;
        const suggestAccountId = this.adhocAuthor?.type === "account" ? this.adhocAuthor.id : soleAccountId;
        // Peek the cache without starting a fetch — chats load on the first click in the field.
        const cached = suggestAccountId ? this.dialogsByAccount.get(suggestAccountId) : undefined;
        input.placeholder = hasChips ? "" : (
            suggestAccountId
                ? (cached?.loading ? t.SETTING_CHAT_PICKER_LOADING : t.SETTING_PLACEHOLDER_CHAT_SEARCH)
                : t.SETTING_PLACEHOLDER_CHAT
        );

        // The suggest is created lazily, on the first real user gesture in the field. Merely
        // constructing it wires Obsidian's own focus→getSuggestions handler, which would fetch
        // the chat list and pop the suggestions open as soon as the modal autofocuses this
        // input on open. Until then the field is a plain @username/ID entry box.
        let suggest: ChatSuggest | null = null;
        this.adhocActivatePicker = null;
        if (suggestAccountId) {
            const accountId = suggestAccountId;
            this.adhocActivatePicker = () => {
                if (!suggest) {
                    // Kick off the (cached, once-per-account) dialog fetch only now; show the
                    // loading placeholder until it resolves (dialogsFor clears it).
                    if (this.dialogsFor(accountId).loading && !hasChips) {
                        input.placeholder = t.SETTING_CHAT_PICKER_LOADING;
                    }
                    suggest = new ChatSuggest(
                        this.app, input,
                        () => this.dialogsFor(accountId).fetch,
                        () => this.adhocTargets,
                    );
                    this.adhocActiveSuggest = suggest;
                    suggest.onPick = async (dialog: DialogData) => {
                        const isDupe = this.adhocTargets.some(x => x.id === dialog.id && x.topicId === dialog.topicId);
                        if (!isDupe) this.adhocTargets.push({ id: dialog.id, title: dialog.title, topicId: dialog.topicId });
                        this.renderAdhocPickerField();
                    };
                }
                // The input is already focused here, so the suggest's own focus handler won't
                // fire — nudge it with an input event so it runs its first query (async: it
                // opens once the dialogs resolve).
                input.dispatchEvent(new Event("input"));
            };
        }

        // Keyboard-only path: tabbing in and typing arms the picker too.
        input.addEventListener("input", () => { if (!suggest) this.adhocActivatePicker?.(); });

        // Manual entry: Enter adds an @username/ID chip. Registered after the suggest's own
        // keydown so it fires second (if the suggest picked an item, input.value is empty).
        input.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key !== "Enter") return;
            const id = input.value.trim();
            if (!id) return;
            e.preventDefault();
            if (!this.adhocTargets.some(x => x.id === id)) this.adhocTargets.push({ id });
            this.renderAdhocPickerField();
            this.adhocPickerFieldEl?.querySelector<HTMLInputElement>(".telegram-chat-search")?.focus();
        });
    }

    // Returns (creating + caching on first use) the dialog-fetch state for an account, so the
    // ad-hoc chat picker can suggest chats. One fetch per account for the modal's lifetime.
    private dialogsFor(accountId: string): { fetch: Promise<DialogData[]>; loading: boolean } {
        const cached = this.dialogsByAccount.get(accountId);
        if (cached) return cached;
        const secrets = this.plugin.getAccountSecrets(accountId);
        const entry: { fetch: Promise<DialogData[]>; loading: boolean } = { fetch: Promise.resolve([]), loading: true };
        entry.fetch = (async () => {
            const client = await createClient(
                secrets.telegramSession, secrets.telegramApiId, secrets.telegramApiHash
            ).catch(() => null);
            const dialogs = client ? await getUserDialogs(client) : [];
            await client?.destroy().catch(() => {});
            entry.loading = false;
            this.contentEl.querySelectorAll<HTMLInputElement>('.telegram-chat-search').forEach(input => {
                if (input.placeholder === t.SETTING_CHAT_PICKER_LOADING) {
                    input.placeholder = t.SETTING_PLACEHOLDER_CHAT_SEARCH;
                }
            });
            return dialogs;
        })();
        this.dialogsByAccount.set(accountId, entry);
        return entry;
    }

    // Assembles a throwaway TelegramChannel from the ad-hoc selections, or null if incomplete.
    private buildAdhocChannel(): TelegramChannel | null {
        if (!this.adhocAuthor || !this.adhocMethod || this.adhocTargets.length === 0) return null;
        const isBot = this.adhocAuthor.type === "bot";
        const targets = this.adhocTargets.map(target => ({ ...target }));
        return {
            id: `adhoc-${Date.now()}`,
            name: "",
            defaultMethod: this.adhocMethod,
            chatTargets: targets,
            chatId: targets[0]?.id ?? "",
            chatTitle: targets[0]?.title,
            topicId: targets[0]?.topicId,
            isDefault: false,
            accountId: isBot ? undefined : this.adhocAuthor.id,
            botTokenId: isBot ? this.adhocAuthor.id : undefined,
            botToken: isBot ? (this.app.secretStorage.getSecret(`bot-token-${this.adhocAuthor.id}`) ?? "") : undefined,
        };
    }

    // Builds the split layout: one block per split part with a row of circle setting buttons
    // (send / silent / attachments / schedule pill) above a rendered preview clamped to a few
    // lines with an expand control. The send button chooses whether the part gets published:
    // a part whose marker already carries links was published before, so it starts off;
    // turning it on re-posts the part as a new message (the fresh link joins its marker).
    // Fetches OpenGraph metadata for a link-preview card, cached per URL. Falls back to
    // just the hostname when the page can't be fetched or parsed.
    private fetchLinkPreview(url: string): Promise<{ siteName: string; title?: string; description?: string; image?: string }> {
        const cached = this.linkPreviewCache.get(url);
        if (cached) return cached;
        const hostname = new URL(url).hostname.replace(/^www\./, "");
        const promise = (async () => {
            try {
                const res = await requestUrl({ url });
                const doc = new DOMParser().parseFromString(res.text, "text/html");
                const og = (prop: string) => doc.querySelector(`meta[property="og:${prop}"], meta[name="og:${prop}"]`)?.getAttribute("content") ?? undefined;
                const rawImage = og("image");
                return {
                    siteName: og("site_name") ?? hostname,
                    title: og("title") ?? doc.querySelector("title")?.textContent?.trim() ?? undefined,
                    description: og("description") ?? doc.querySelector('meta[name="description"]')?.getAttribute("content") ?? undefined,
                    image: rawImage ? new URL(rawImage, url).href : undefined,
                };
            } catch {
                return { siteName: hostname };
            }
        })();
        this.linkPreviewCache.set(url, promise);
        return promise;
    }

    // Splits a part's content into the post itself and its pre-written comments (embedded
    // .md notes) when "Treat .md embeds as post comments" is on. Mirrors the send paths'
    // collection (same three embed syntaxes, commented-out regions ignored, deduped by
    // path, same order), so the previewed comments match what actually gets published.
    // The embed markup is stripped from the returned post content — the comments are not
    // part of the post message and render as their own preview blocks instead.
    private collectCommentPreviews(content: string): { cleaned: string; files: TFile[] } {
        const resolveMdEmbed = (rawPath: string): TFile | null => {
            let cleanPath = rawPath.split(/\s+"/)[0].split(/[?#]/)[0].trim();
            if (/^https?:\/\//i.test(cleanPath)) return null;
            try { cleanPath = decodeURIComponent(cleanPath); } catch { /* keep raw path if not URI-encoded */ }
            const resolved = this.app.metadataCache.getFirstLinkpathDest(cleanPath, this.file.path);
            return resolved instanceof TFile && resolved.extension === "md" ? resolved : null;
        };

        const wikilinkRegex = () => /!\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g;
        const mdLinkRegex = () => /!\[[^\]]*\]\(([^)]+)\)/g;
        const reverseMdLinkRegex = () => /!\(([^)]+)\)\[[^\]]*\]/g;

        const seen = new Set<string>();
        const files: TFile[] = [];
        const scanBody = stripComments(content);
        for (const regex of [wikilinkRegex(), mdLinkRegex(), reverseMdLinkRegex()]) {
            let m: RegExpExecArray | null;
            while ((m = regex.exec(scanBody)) !== null) {
                const file = resolveMdEmbed(m[1]);
                if (file && !seen.has(file.path)) {
                    seen.add(file.path);
                    files.push(file);
                }
            }
        }

        const stripIfComment = (match: string, rawPath: string) => resolveMdEmbed(rawPath) ? "" : match;
        const cleaned = content
            .replace(wikilinkRegex(), stripIfComment)
            .replace(mdLinkRegex(), stripIfComment)
            .replace(reverseMdLinkRegex(), stripIfComment);
        return { cleaned, files };
    }

    // The modes a previewed message offers and the one it starts in, from the links already
    // recorded for it.
    //
    // A message with no recorded link has nothing to edit and defaults to "publish"; a lone
    // post in that state has no decision left to make at all (empty `modes` ⇒ no toggle is
    // rendered). Everything else can at least be skipped.
    //
    // A message that already went out defaults to being left alone ("ignore"), since
    // re-sending it would duplicate it — except on a single-post note, where the one post
    // (and its comments) is almost certainly being updated, so "edit" is the default.
    private modeSetupFor(links: string[], kind: CardRow["kind"]): { modes: SplitMode[]; mode: SplitMode } {
        const lonePost = this.splitPosts.length === 1 && kind === "post";
        if (links.length === 0) return lonePost
            ? { modes: [], mode: "publish" }
            : { modes: ["ignore", "publish"], mode: "publish" };
        return {
            modes: lonePost ? ["publish", "edit"] : ["ignore", "publish", "edit"],
            mode: this.splitPosts.length === 1 ? "edit" : "ignore",
        };
    }

    // Applies a mode picked on a card's toggle and refreshes the per-message option states that
    // depend on the publish/edit split.
    private setSplitMode(row: CardRow, mode: SplitMode) {
        row.mode = mode;
        row.applyMode();
        // Choosing what to edit can settle which preset performs it.
        this.autoSelectPresetForEdit();
        this.refreshOptionStates();
    }

    // Chat info for a link whichever spelling it's recorded in: the note's properties keep
    // the full `https://t.me/…` form, split markers the compact `t.me/…` one, and the same
    // message can be reached through either.
    private resolvedInfoFor(link: string): { title: string | null; isChannel: boolean } | undefined {
        const exact = this.resolvedLinks.get(link);
        if (exact) return exact;
        for (const [key, info] of this.resolvedLinks) {
            if (linksMatch(key, link)) return info;
        }
        return undefined;
    }

    // How a stored link is named in the UI: the chat it lives in and the message's id, e.g.
    // "My Channel: 102". Falls back to the chat id from the link itself while its title is
    // still resolving, and to the whole link for anything that isn't a recognizable post link.
    private linkLabel(link: string): string {
        const parsed = parseLinkComponents(link);
        if (!parsed) return link;
        return `${this.resolvedInfoFor(link)?.title ?? parsed.chatId}: ${parsed.messageId}`;
    }

    // The dropdown behind the "Edit" segment when a message has several published links: pick
    // which one the edit rewrites, or all of them at once. Anchored to the segment's own left
    // edge rather than the pointer, so it opens in the same place however it was activated.
    private openEditLinkMenu(anchorEl: HTMLElement, row: CardRow) {
        const menu = new Menu();
        menu.addItem(item => item
            .setTitle(t.MULTI_PRESET_EDIT_COMMENTS_ALL_CHATS)
            .setChecked(row.editLink === "all")
            .onClick(() => { row.editLink = "all"; this.setSplitMode(row, "edit"); }));
        for (const link of row.editLinks) {
            menu.addItem(item => item
                .setTitle(this.linkLabel(link))
                .setChecked(row.editLink === link)
                .onClick(() => { row.editLink = link; this.setSplitMode(row, "edit"); }));
        }
        const rect = anchorEl.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom + 2 });
    }

    // Builds the previews: one card per split part, each followed by a card for every
    // pre-written comment that rides along with it. Cards are identical in structure — a
    // settings row, a clamped preview and a mode toggle — so the whole layout is one
    // renderCard call per message.
    private renderSplitSection(container: HTMLElement): void {
        this.splitRenderComponent.load();
        // Obsidian's bundled lucide set lacks these two — register them so setIcon renders them.
        if (!getIcon("link-2-off")) addIcon("link-2-off", LINK_2_OFF_ICON);
        if (!getIcon("ban")) addIcon("ban", BAN_ICON);
        const sectionEl = container.createDiv("telegram-split-section");
        // A lone previewed post gets a taller collapsed clamp than a multi-post split.
        if (this.splitPosts.length === 1) sectionEl.addClass("telegram-split-section--single");

        for (const post of this.splitPosts) {
            const postEl = sectionEl.createDiv("telegram-split-post");
            // Pre-written comments publish as separate messages, so their embed markup is
            // pulled out of the post's own preview and each gets its own card below it.
            const { cleaned, files: commentFiles } = this.plugin.settings.treatMdEmbedsAsComments
                ? this.collectCommentPreviews(post.content)
                : { cleaned: post.content, files: [] as TFile[] };

            const row = this.renderCard({
                parent: postEl,
                kind: "post",
                // A split note edits through its own markers; a single-post note has none, so
                // its links come from the `tg_posts` property instead.
                links: this.splitPosts.length === 1 ? this.storedPostLinks : post.links,
                previewCls: "telegram-split-preview",
                contentCls: "telegram-split-preview-content",
                render: contentEl => MarkdownRenderer.render(this.app, cleaned, contentEl, this.file.path, this.splitRenderComponent),
            });

            // The part's comments live in a card of their own, set apart from the post card
            // they belong to, under one shared "Comments" heading.
            if (commentFiles.length > 0) {
                const commentsEl = sectionEl.createDiv("telegram-split-comments");
                commentsEl.createDiv({ text: t.MULTI_PRESET_SPLIT_COMMENT_LABEL, cls: "telegram-split-comments-header" });
                for (const commentFile of commentFiles) {
                    // The comment's position among the note's comment notes: both its stored
                    // links and the offset an edit needs are looked up by it.
                    const embedIndex = this.commentEmbedOrder.indexOf(commentFile.path);
                    row.comments.push(this.renderCard({
                        parent: commentsEl.createDiv("telegram-split-comment"),
                        kind: "comment",
                        links: embedIndex < 0 ? [] : this.commentEditLinks(embedIndex),
                        embedIndex,
                        previewCls: "telegram-split-comment-preview",
                        contentCls: "telegram-split-comment-content",
                        render: async contentEl => {
                            const raw = await this.app.vault.cachedRead(commentFile);
                            await MarkdownRenderer.render(
                                this.app,
                                raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""),
                                contentEl,
                                commentFile.path,
                                this.splitRenderComponent,
                            );
                        },
                    }));
                }
            }

            this.splitRows.push(row);
        }
    }

    // Builds one previewed message: its settings row of circle buttons, the rendered preview
    // with its expand control, and the mode toggle underneath. Post and comment cards differ
    // only in the classes their preview uses (a comment's clamp is shorter) and in which
    // options apply — a comment goes out as a text reply, so attachment positioning and
    // scheduling are permanently blocked on it.
    private renderCard(params: {
        parent: HTMLElement;
        kind: CardRow["kind"];
        links: string[];
        previewCls: string;
        contentCls: string;
        embedIndex?: number;
        render: (contentEl: HTMLElement) => Promise<void>;
    }): CardRow {
        const { parent, kind, links } = params;
        const isPost = kind === "post";
        const setup = this.modeSetupFor(links, kind);
        const row: CardRow = {
            kind,
            mode: setup.mode,
            editLinks: links,
            // With several links to choose from the user has to pick one before publishing;
            // a lone link needs no choice.
            editLink: links.length === 1 ? links[0] : null,
            applyMode: () => {},
            silentOn: this.plugin.settings.alwaysSilent,
            attachOn: false,
            previewMode: "default",
            updateLinkPreviewCard: () => {},
            linkPreviewUrl: null,
            onlineOn: false,
            scheduleValue: "",
            richBlocked: false,
            schedBlocked: false,
            editBlocked: false,
            ignoreBlocked: setup.mode === "ignore",
            overrides: new Set(),
            applyRichState: () => {},
            applySchedState: () => {},
            applyModeState: () => {},
            embedIndex: params.embedIndex ?? -1,
            comments: [],
        };
        // ── Settings row ──
        const controlsEl = parent.createDiv("telegram-split-controls");

        const silentBtn = controlsEl.createEl("button", { cls: "telegram-split-circle-btn", attr: { type: "button" } });
        enableLongPressTooltip(silentBtn);
        const applySilent = () => {
            const effective = row.silentOn && !row.editBlocked && !row.ignoreBlocked;
            setIcon(silentBtn, effective ? "bell-off" : "bell");
            silentBtn.toggleClass("is-active", effective);
        };
        applySilent(); // reflects the "Always publish silently" default
        setTooltip(silentBtn, t.MULTI_PRESET_SILENT_POST_NAME);
        silentBtn.addEventListener("click", () => {
            row.silentOn = !row.silentOn;
            applySilent();
            this.shareSetting(row, "silent");
        });

        // Attachment positioning applies to a post's caption and, on a comment, to whatever
        // media the reply carries — which is its link preview.
        const attachBtn = controlsEl.createEl("button", { cls: "telegram-split-circle-btn", attr: { type: "button" } });
        enableLongPressTooltip(attachBtn);
        setIcon(attachBtn, "image-down");
        setTooltip(attachBtn, t.MULTI_PRESET_ATTACHMENTS_NAME);
        const applyAttach = () => attachBtn.toggleClass("is-active", row.attachOn && !row.richBlocked && !row.ignoreBlocked);
        attachBtn.addEventListener("click", () => {
            row.attachOn = !row.attachOn;
            applyAttach();
            this.shareSetting(row, "attach");
        });

        // Link-preview placement, cycling through three states: default (Telegram's
        // automatic placement) → preview above the text → preview disabled entirely.
        // While a rich method blocks the option, the button shows the default state.
        const previewModeBtn = controlsEl.createEl("button", { cls: "telegram-split-circle-btn", attr: { type: "button" } });
        enableLongPressTooltip(previewModeBtn);
        const applyPreviewMode = () => {
            const mode = row.richBlocked || row.editBlocked || row.ignoreBlocked ? "default" : row.previewMode;
            setIcon(previewModeBtn, mode === "off" ? "link-2-off" : "panel-top-close");
            setTooltip(previewModeBtn, mode === "top" ? t.MULTI_PRESET_SPLIT_PREVIEW_TOP
                : mode === "off" ? t.MULTI_PRESET_SPLIT_PREVIEW_OFF
                : t.MULTI_PRESET_SPLIT_PREVIEW_DEFAULT);
            previewModeBtn.toggleClass("is-active", mode !== "default");
            // The in-preview card mirrors the mode (placement / hidden); late-bound —
            // it's a noop until the preview block below is built.
            row.updateLinkPreviewCard();
        };
        applyPreviewMode();
        previewModeBtn.addEventListener("click", () => {
            row.previewMode = row.previewMode === "default" ? "top" : row.previewMode === "top" ? "off" : "default";
            applyPreviewMode();
            this.shareSetting(row, "preview");
        });

        // "Send when online": Telegram delivers once the recipient comes online. On a post it
        // rides the same schedule slot as a date, so the two are mutually exclusive; a comment
        // has no date of its own (it goes out with its post) but carries this on its own reply.
        // Both share scheduling's method restrictions (account methods only).
        const onlineBtn = controlsEl.createEl("button", { cls: "telegram-split-circle-btn", attr: { type: "button" } });
        enableLongPressTooltip(onlineBtn);
        setIcon(onlineBtn, "wifi");
        setTooltip(onlineBtn, t.MULTI_PRESET_SPLIT_ONLINE_TIP);
        // schedBlocked already carries the "ignore" mode (updateScheduleState), so the two
        // scheduling controls need no ignoreBlocked check of their own.
        const applyOnline = () => onlineBtn.toggleClass("is-active", row.onlineOn && !row.schedBlocked);

        // Scheduling is a round button like the rest of the row. The native datetime input
        // rides inside it — invisible and click-through — purely to own the picker and hold
        // the chosen value; the button carries the state (active + the date in its tooltip).
        const scheduleBtn = controlsEl.createEl("button", { cls: "telegram-split-circle-btn telegram-split-schedule-btn", attr: { type: "button" } });
        enableLongPressTooltip(scheduleBtn);
        // The icon lives in its own span so nothing that re-renders it can wipe out the input.
        setIcon(scheduleBtn.createSpan("telegram-split-schedule-icon"), getIcon("calendar-clock") ? "calendar-clock" : "calendar");
        const scheduleInput = scheduleBtn.createEl("input", { cls: "telegram-split-schedule-input" });
        scheduleInput.type = "datetime-local";

        const applySchedule = () => {
            const on = !!row.scheduleValue && !row.schedBlocked && isPost;
            scheduleBtn.toggleClass("is-active", on);
            // With the date no longer written in the row, the tooltip is what tells the user
            // when the post is going out.
            setTooltip(scheduleBtn, on
                ? t.MULTI_PRESET_SPLIT_SCHEDULE_AT.replace("{date}", new Date(row.scheduleValue).toLocaleString())
                : t.MULTI_PRESET_SCHEDULE_NAME);
        };

        // showPicker() is the only way to open the picker from the button, since the input
        // itself takes no clicks. Webviews without it fall back to a synthetic tap on the
        // input, which is what opens the picker on mobile.
        const openSchedulePicker = () => {
            try { scheduleInput.showPicker(); }
            catch { scheduleInput.click(); }
        };

        scheduleBtn.addEventListener("click", () => {
            // With a date already chosen there are two things the user might want, so the
            // button offers them rather than silently reopening the picker.
            if (!row.scheduleValue) { openSchedulePicker(); return; }
            const menu = new Menu();
            menu.addItem(item => item
                .setTitle(t.MULTI_PRESET_SPLIT_SCHEDULE_CHANGE)
                .setIcon("calendar")
                .onClick(() => openSchedulePicker()));
            menu.addItem(item => item
                .setTitle(t.MULTI_PRESET_SPLIT_SCHEDULE_CLEAR)
                .setIcon("x")
                .onClick(() => {
                    row.scheduleValue = "";
                    scheduleInput.value = "";
                    applySchedule();
                }));
            const rect = scheduleBtn.getBoundingClientRect();
            menu.showAtPosition({ x: rect.left, y: rect.bottom + 2 });
        });

        // row.scheduleValue is authoritative; the input is just its view, so the value
        // can be visually cleared while a conflicting method blocks scheduling and
        // restored intact when a supported method returns.
        scheduleInput.addEventListener("input", () => {
            row.scheduleValue = scheduleInput.value;
            if (scheduleInput.value && row.onlineOn) {
                row.onlineOn = false;
                applyOnline();
            }
            applySchedule();
        });
        onlineBtn.addEventListener("click", () => {
            row.onlineOn = !row.onlineOn;
            // Choosing "when online" discards a picked date (and vice versa).
            if (row.onlineOn) {
                row.scheduleValue = "";
                scheduleInput.value = "";
                applySchedule();
            }
            applyOnline();
            this.shareSetting(row, "online");
        });

        row.applyRichState = () => {
            attachBtn.toggleClass("is-disabled", row.richBlocked || row.ignoreBlocked);
            previewModeBtn.toggleClass("is-disabled", row.richBlocked || row.editBlocked || row.ignoreBlocked);
            applyAttach();
            applyPreviewMode();
        };
        // A scheduled date is the one option a comment genuinely can't hold: it is sent as a
        // reply to its post, so it goes out when the post does. "Send when online" is a
        // property of the reply itself and stays available.
        row.applySchedState = () => {
            const dateBlocked = row.schedBlocked || !isPost;
            onlineBtn.toggleClass("is-disabled", row.schedBlocked);
            scheduleBtn.toggleClass("is-disabled", dateBlocked);
            scheduleInput.disabled = dateBlocked;
            scheduleInput.value = dateBlocked ? "" : row.scheduleValue;
            applySchedule();
            applyOnline();
        };

        // A message set to "edit" keeps its preview visible but greys out (and visually
        // resets) the options that don't apply to an edit; attachments positioning
        // stays usable. A message set to "ignore" isn't sent at all, so its whole settings
        // row goes dead — only the mode toggle below it still responds.
        row.applyModeState = () => {
            silentBtn.toggleClass("is-disabled", row.editBlocked || row.ignoreBlocked);
            applySilent();
            // Re-applies the attachment / preview-mode buttons too — their disabled state
            // mixes in editBlocked and ignoreBlocked, which may have just changed.
            row.applyRichState();
        };

        // ── Preview ──
        const previewEl = parent.createDiv(params.previewCls);
        // markdown-rendered pulls in Obsidian's reading-view styling so the preview
        // looks exactly like the note's own preview.
        const previewContentEl = previewEl.createDiv(`${params.contentCls} markdown-rendered`);
        // Telegram-style card showing what the chosen link's preview will look like.
        // It lives INSIDE the text flow (previewContentEl) so it clamps and scrolls with
        // the content; hidden until a link is selected, moved above/below the text by mode.
        const linkCardEl = previewContentEl.createDiv("telegram-split-linkpreview is-hidden");
        const expandBtn = previewEl.createEl("button", { cls: "telegram-split-expand", attr: { type: "button" } });
        enableLongPressTooltip(expandBtn);
        setIcon(expandBtn, "chevron-down");
        setTooltip(expandBtn, t.MULTI_PRESET_SPLIT_EXPAND);
        let expanded = false;
        expandBtn.addEventListener("click", () => {
            expanded = !expanded;
            previewEl.toggleClass("is-expanded", expanded);
            setIcon(expandBtn, expanded ? "chevron-up" : "chevron-down");
            setTooltip(expandBtn, expanded ? t.MULTI_PRESET_SPLIT_COLLAPSE : t.MULTI_PRESET_SPLIT_EXPAND);
        });
        // Shows the expand control only while the collapsed clamp actually clips content.
        // Re-run whenever the content height changes — the link-preview card appearing,
        // growing (OpenGraph data arriving) or disappearing can flip the answer.
        const refreshExpand = () => {
            if (expanded) return;
            const clipped = previewContentEl.scrollHeight > previewContentEl.clientHeight + 1;
            expandBtn.toggle(clipped);
            previewEl.toggleClass("no-expand", !clipped);
        };
        // Renders / repositions the card imitating the chosen link's Telegram preview:
        // hidden with no link chosen (or previews disabled), placed above or below the
        // text to mirror where Telegram will put it. Content is rebuilt only when the
        // URL changes; OpenGraph data fills in asynchronously over the URL skeleton.
        let cardUrl: string | null = null;
        row.updateLinkPreviewCard = () => {
            // Telegram renders a preview by default — for the first web link in the
            // text — so with no explicit selection the card falls back to that link.
            const autoUrl = (): string | null => {
                for (const a of Array.from(previewContentEl.querySelectorAll("a"))) {
                    const href = a.getAttribute("href") ?? "";
                    if (/^https?:\/\//i.test(href)) return href;
                }
                return null;
            };
            // While a rich method (or an edit / ignore selection) blocks link-preview options
            // the card shows the default behaviour, matching the reset mode button.
            const mode = row.richBlocked || row.editBlocked || row.ignoreBlocked ? "default" : row.previewMode;
            const url = row.linkPreviewUrl ?? autoUrl();
            if (!url || mode === "off") {
                linkCardEl.addClass("is-hidden");
                window.requestAnimationFrame(refreshExpand);
                return;
            }
            linkCardEl.removeClass("is-hidden");
            // In the text flow: first child of the content in "top" mode, last otherwise —
            // so it scrolls (and clamps) together with the text.
            if (mode === "top") previewContentEl.insertBefore(linkCardEl, previewContentEl.firstChild);
            else previewContentEl.appendChild(linkCardEl);
            window.requestAnimationFrame(refreshExpand);
            if (cardUrl === url) return;
            cardUrl = url;
            linkCardEl.empty();
            const textEl = linkCardEl.createDiv("telegram-split-linkpreview-text");
            const siteEl = textEl.createDiv({ cls: "telegram-split-linkpreview-site", text: new URL(url).hostname.replace(/^www\./, "") });
            const titleEl = textEl.createDiv({ cls: "telegram-split-linkpreview-title", text: url });
            void this.fetchLinkPreview(url).then(data => {
                if (cardUrl !== url || !linkCardEl.isConnected) return;
                siteEl.setText(data.siteName);
                if (data.title) titleEl.setText(data.title);
                if (data.description) textEl.createDiv({ cls: "telegram-split-linkpreview-desc", text: data.description });
                if (data.image) {
                    const img = linkCardEl.createEl("img", { cls: "telegram-split-linkpreview-image" });
                    img.src = data.image;
                    img.addEventListener("error", () => img.remove());
                }
                window.requestAnimationFrame(refreshExpand);
            });
        };

        // Clicking a web link chooses it as this message's link-preview source (clicking
        // the chosen one again clears the choice); Ctrl/Cmd+Click keeps the normal
        // behaviour of opening the link. Capture phase so the anchor's own handlers never fire.
        previewContentEl.addEventListener("click", (e: MouseEvent) => {
            const anchor = (e.target as HTMLElement).closest("a");
            if (!anchor || !/^https?:\/\//i.test(anchor.getAttribute("href") ?? "")) return;
            if (e.ctrlKey || e.metaKey) return;
            e.preventDefault();
            e.stopPropagation();
            const current = previewContentEl.querySelector("a.is-preview-source");
            current?.removeClass("is-preview-source");
            if (current === anchor) {
                row.linkPreviewUrl = null;
            } else {
                anchor.addClass("is-preview-source");
                row.linkPreviewUrl = anchor.getAttribute("href");
            }
            row.updateLinkPreviewCard();
        }, { capture: true });

        void params.render(previewContentEl)
            .then(() => window.requestAnimationFrame(() => {
                // Explain the click behaviour on every selectable web link.
                previewContentEl.querySelectorAll<HTMLAnchorElement>("a").forEach(a => {
                    if (/^https?:\/\//i.test(a.getAttribute("href") ?? "")) setTooltip(a, t.MULTI_PRESET_SPLIT_LINK_TIP);
                });
                // Now that the links exist, show Telegram's default preview (first link).
                row.updateLinkPreviewCard();
                refreshExpand();
            }));

        // ── Mode footer ──
        // The bar of buttons closing the card, choosing what happens to this message:
        // ignore / publish / edit. Only the applicable modes are offered (modeSetupFor), and a
        // message with nothing to decide gets no footer at all. When several published links
        // exist, the "Edit" button opens a menu to pick which message the edit rewrites.
        if (setup.modes.length > 0) {
            const modeRowEl = parent.createDiv("telegram-split-mode-row");
            // The hint goes in first: it reads above the bar, which stays flush with the
            // bottom edge of the block. It's taken out of the flow and slides out from behind
            // the bar (see styles.css), so appearing and disappearing moves nothing else.
            const hintEl = modeRowEl.createDiv("telegram-split-mode-hint");
            const toggleEl = modeRowEl.createDiv("telegram-split-mode-toggle");
            // Several links to choose from: the edit segment becomes a dropdown, and
            // publishing is blocked until one of them is picked.
            const needsPick = links.length > 1;
            const segmentEls = new Map<SplitMode, HTMLElement>();

            row.applyMode = () => {
                segmentEls.forEach((el, mode) => el.toggleClass("is-selected", mode === row.mode));
                const link = row.editLink;
                // Nothing to say while no target is chosen — the attempt to publish is what
                // reports that, so the card doesn't carry a standing error message.
                const hint = row.mode !== "edit" || link === null ? ""
                    : link === "all" ? t.MULTI_PRESET_UPDATE_WILL_USE_ALL
                    : t.MULTI_PRESET_UPDATE_WILL_USE.replace("{name}", this.linkLabel(link));
                // Keep the old text while it slides back out of view, so the label doesn't
                // blank out mid-animation.
                if (hint) hintEl.setText(hint);
                hintEl.toggleClass("is-visible", hint.length > 0);
            };

            for (const [mode, icon, label] of splitModeSegments()) {
                if (!setup.modes.includes(mode)) continue;
                const segEl = toggleEl.createEl("button", { cls: "telegram-split-mode-option", attr: { type: "button" } });
                enableLongPressTooltip(segEl);
                setIcon(segEl.createSpan("telegram-split-mode-icon"), icon);
                segEl.createSpan({ cls: "telegram-split-mode-label", text: label });
                if (mode === "edit" && needsPick) {
                    setIcon(segEl.createSpan("telegram-split-mode-caret"), "chevron-down");
                    setTooltip(segEl, t.MULTI_PRESET_SPLIT_MODE_EDIT_PICK);
                }
                segEl.addEventListener("click", () => {
                    if (mode === "edit" && needsPick) this.openEditLinkMenu(segEl, row);
                    else this.setSplitMode(row, mode);
                });
                segmentEls.set(mode, segEl);
            }
            row.applyMode();
        }

        return row;
    }

    // The per-part options to publish with, or undefined when there are no previews at all.
    // A control blocked by the chosen method (or by the card's kind) keeps its stored state
    // internally but must not affect the publish — it's collected as unset instead.
    private collectSplitPartOptions(): SplitPartOptions[] | undefined {
        if (this.splitRows.length === 0) return undefined;
        return this.splitRows.map(row => ({
            // Only the parts set to "publish" go out as new messages; "ignore" and "edit"
            // parts are skipped by the send paths (an edit runs as its own pass).
            selected: row.mode === "publish",
            silent: row.silentOn,
            attachUnderText: !row.richBlocked && row.attachOn,
            scheduleDate: !row.schedBlocked && !row.onlineOn && row.scheduleValue
                ? new Date(row.scheduleValue) : undefined,
            sendWhenOnline: !row.schedBlocked && row.onlineOn,
            linkPreviewUrl: !row.richBlocked ? row.linkPreviewUrl ?? undefined : undefined,
            linkPreviewAboveText: !row.richBlocked && row.previewMode === "top",
            linkPreviewDisabled: !row.richBlocked && row.previewMode === "off",
            // A comment carries only what a reply can: everything the post does except a
            // scheduled date, which it has no use for — it goes out with the post it replies to.
            comments: row.comments.map(comment => ({
                selected: comment.mode === "publish",
                silent: comment.silentOn,
                attachUnderText: !comment.richBlocked && comment.attachOn,
                sendWhenOnline: !comment.schedBlocked && comment.onlineOn,
                linkPreviewUrl: !comment.richBlocked ? comment.linkPreviewUrl ?? undefined : undefined,
                linkPreviewAboveText: !comment.richBlocked && comment.previewMode === "top",
                linkPreviewDisabled: !comment.richBlocked && comment.previewMode === "off",
            })),
        }));
    }

    async onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText(t.MULTI_PRESET_TITLE);

        // Every publish shows previews: one post for a plain note, several for a note
        // split with `%% \split %%` markers.
        const noteContent = await this.app.vault.cachedRead(this.file);
        const noteBody = noteContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
        this.splitPosts = parseSplitPosts(noteBody);

        // Read before the previews are built: the mode toggles offer exactly the links recorded
        // in the note's properties (a single-post note's post links, and every comment link).
        const cache = this.app.metadataCache.getFileCache(this.file);
        const readLinks = (key: string): string[] => {
            const raw: unknown = cache?.frontmatter?.[key];
            return Array.isArray(raw) ? raw.map(String) : (typeof raw === 'string' ? [raw] : []);
        };
        const allStoredPostLinks = readLinks("tg_posts");
        const allStoredCommentLinks = readLinks("tg_comments");
        this.storedPostLinks = allStoredPostLinks;
        this.storedCommentLinks = allStoredCommentLinks;
        // The note's comment notes in whole-note collection order — the order the send paths
        // record their links in, so a comment's position here is what targets it on an edit.
        this.commentEmbedOrder = this.plugin.settings.treatMdEmbedsAsComments
            ? this.collectCommentPreviews(noteBody).files.map(f => f.path)
            : [];

        const hasPresets = this.plugin.settings.channels.length > 0;
        const hasAuthors = this.plugin.settings.accounts.length > 0 || this.plugin.settings.botTokens.length > 0;

        // Nothing to post with at all: no presets and no author to publish ad-hoc from.
        if (!hasPresets && !hasAuthors) {
            contentEl.createEl("p", { text: t.NOTICE_ERR_CONFIG });
            return;
        }

        // ─── Post without a preset ────────────────────────────────────────────────────
        // Pick targets + an author + a method here to publish once without a saved preset.
        if (hasAuthors) this.renderAdhocSection(contentEl);

        if (hasPresets) contentEl.createDiv({
            text: t.MULTI_PRESET_CHANNEL_SELECTION,
            cls: "telegram-modal-heading"
        });

        const listContainer = contentEl.createDiv("telegram-multi-preset-list");

        const singlePreset = this.plugin.settings.channels.length === 1;

        this.plugin.settings.channels.forEach(channel => {
            const itemEl = listContainer.createDiv("telegram-multi-preset-item");
            if (singlePreset) itemEl.addClass("telegram-multi-preset-item--single");

            const headerEl = itemEl.createDiv("telegram-multi-preset-header");
            const nameEl = headerEl.createDiv("telegram-multi-preset-name");
            nameEl.createSpan({ text: channel.name || t.CHANNEL_DEFAULT_NAME });

            const isPreToggled = this.initialChannelId === channel.id;
            if (isPreToggled) this.selectedChannels.add(channel.id);

            const defaultMethod = channel.defaultMethod ?? "account";

            // Method picker: one toggle per method the preset exposes (secondary methods
            // appear only when "Use secondary publication methods" is enabled). It behaves
            // like a radio group — exactly one method stays selected — and is revealed only
            // while the preset itself is toggled on. The preset's configured method is
            // labelled "Default (…)", pinned to the top of the list, and selected initially.
            const methodsEl = itemEl.createDiv("telegram-multi-preset-methods");
            const row = { id: channel.id, container: itemEl, toggle: null as unknown as ToggleComponent, method: defaultMethod, methodsEl };

            const allowedMethods = availableMethods(channel);
            const methodToggles: Array<{ method: PostMethod; toggle: ToggleComponent }> = [];
            let updatingMethods = false;

            const selectMethod = (value: PostMethod) => {
                updatingMethods = true;
                row.method = value;
                for (const mt of methodToggles) mt.toggle.setValue(mt.method === value);
                updatingMethods = false;
                this.updateScheduleState();
                this.updateAttachState();
            };

            const orderedMethods = methodOptions().filter(([value]) => allowedMethods.has(value));
            // The default method always sits at the top of the list.
            orderedMethods.sort((a, b) => Number(b[0] === defaultMethod) - Number(a[0] === defaultMethod));

            for (const [value, label] of orderedMethods) {
                const isDefault = value === defaultMethod;
                const optEl = methodsEl.createDiv("telegram-preset-method-option");
                optEl.createSpan({
                    text: isDefault ? t.MULTI_PRESET_METHOD_DEFAULT.replace("{method}", label) : label,
                    cls: "telegram-preset-method-label",
                });
                const mToggle = new ToggleComponent(optEl.createDiv())
                    .setValue(isDefault)
                    .onChange(val => {
                        if (updatingMethods) return;
                        // Radio behaviour: selecting one clears the rest; the active one
                        // can't be switched off (a method must always be chosen).
                        if (val) selectMethod(value);
                        else if (row.method === value) { updatingMethods = true; mToggle.setValue(true); updatingMethods = false; }
                    });
                methodToggles.push({ method: value, toggle: mToggle });
            }

            methodsEl.toggleClass("is-hidden", !isPreToggled);

            // Only one preset can be selected at a time: toggling one on clears the rest.
            const toggle = new ToggleComponent(headerEl.createDiv("telegram-multi-preset-control"))
                .setValue(isPreToggled)
                .onChange(value => {
                    if (this.updatingPresets) return;
                    this.selectOnlyPreset(value ? channel.id : null);
                });
            row.toggle = toggle;

            this.channelRows.push(row);
        });

        contentEl.createDiv({
            text: t.MULTI_PRESET_ADVANCED_FORMATTING,
            cls: "telegram-modal-heading"
        });

        // Message previews: one card per part, one per pre-written comment. Each carries its
        // own settings row and (unless there's nothing to decide) a mode toggle choosing
        // whether that message is ignored, published or edited.
        if (this.splitPosts.length > 0) this.renderSplitSection(contentEl);

        // Initial state now that all option elements exist: the cards' default modes decide
        // which options apply, and the footers start closed unless a preset is already settled —
        // either by the command that opened the modal, or by a card that starts out editing a
        // link only one preset can reach.
        this.autoSelectPresetForEdit();
        this.refreshOptionStates();

        // ─── Stored-link resolution ───────────────────────────────────────────────────
        // Editing is chosen per message on the cards above; all that's left note-wide is
        // resolving each stored link's chat, which turns the mode hints into "Will edit in
        // <chat>" and gives the fallback edit route a title to work with. A split note edits
        // through the links in its own markers, so those are resolved too — deduped against
        // the properties, which record the same messages in the full `https://` form.
        const linksToResolve = [...allStoredPostLinks, ...allStoredCommentLinks];
        for (const post of this.splitPosts) {
            for (const link of post.links) {
                if (!linksToResolve.some(existing => linksMatch(existing, link))) linksToResolve.push(link);
            }
        }

        if (linksToResolve.length > 0 && this.plugin.settings.accounts.length > 0) {
            // The edit pickers are usable straight away (they label their options with the raw
            // links), so this only fills in chat titles — the publish handler awaits it before
            // editing so an edit never runs against an unresolved link.
            this.linkResolution = (async () => {
                const results = await Promise.all(
                    linksToResolve.map(link => fetchEntityInfoAnyAccount(link, this.plugin))
                );
                linksToResolve.forEach((link, i) => {
                    if (results[i]) this.resolvedLinks.set(link, results[i]);
                });
                // Resolved titles make the mode hints read "Will edit in <chat>".
                if (this.contentEl.isConnected) for (const row of this.allCards()) row.applyMode();
            })();
        }

        // ─── Publish Button ───────────────────────────────────────────────────────────

        const btnContainer = contentEl.createDiv("telegram-modal-buttons");
        // One label whatever the cards are set to: the modes say what happens to each message,
        // so the button only has to say "go".
        new ButtonComponent(btnContainer)
            .setButtonText(t.MULTI_PRESET_POST_BTN)
            .setCta()
            .onClick(async () => {
                const editRows = this.editingRows();
                const publishRows = this.publishingRows();

                // A message set to "edit" with several published links needs one picked first —
                // there's no sensible default among them.
                if (editRows.some(row => row.editLink === null)) {
                    new Notice(t.MULTI_PRESET_SPLIT_MODE_NO_LINK);
                    return;
                }

                // A comment goes out as a reply to the post it belongs to, so it can only be
                // published by the same action that publishes that post — the send paths have
                // no message to reply to otherwise.
                if (this.splitRows.some(part => part.mode !== "publish" && part.comments.some(c => c.mode === "publish"))) {
                    new Notice(t.MULTI_PRESET_SPLIT_COMMENT_NEEDS_POST);
                    return;
                }

                const adhocChannel = this.buildAdhocChannel();
                if (publishRows.length > 0 && this.selectedChannels.size === 0 && !adhocChannel) {
                    new Notice(t.MULTI_PRESET_NO_SELECTION);
                    return;
                }
                if (publishRows.length === 0 && editRows.length === 0) {
                    new Notice(t.MULTI_PRESET_SPLIT_NONE_SELECTED);
                    return;
                }

                // Fresh publishes carry all their options per message (the preview cards); the
                // publish-wide silent below only serves the edit paths, where it doesn't
                // apply anyway. An edit's attachment positioning comes from its own card.
                const silent = this.plugin.settings.alwaysSilent;
                const partOptions = publishRows.length > 0 ? this.collectSplitPartOptions() : undefined;
                // Snapshot each edit before the modal (and its cards) go away.
                const edits = editRows.map(row => ({
                    kind: row.kind,
                    embedIndex: row.embedIndex,
                    links: row.editLink === "all" ? row.editLinks : [row.editLink!],
                    attachUnderText: row.attachOn && !row.richBlocked,
                }));

                this.close();

                if (edits.length > 0) {
                    // Chat titles are only needed for the fallback route (no matching preset),
                    // but an edit must never run against a still-unresolved link.
                    await this.linkResolution;
                    for (const edit of edits) {
                        for (const link of edit.links) {
                            if (edit.kind === "comment") await this.editComment(link, edit.embedIndex, silent);
                            else await this.editPost(link, this.resolvedInfoFor(link)?.title ?? null, silent, edit.attachUnderText);
                        }
                    }
                }
                // The messages set to "publish" go out in one pass; partOptions skips the parts
                // and comments set to ignore or edit.
                if (publishRows.length > 0) {
                    for (const channelId of this.selectedChannels) {
                        const channel = this.plugin.settings.channels.find(c => c.id === channelId);
                        const method = this.channelRows.find(r => r.id === channelId)?.method;
                        if (channel) await this.plugin.sendNoteToTelegram(this.file, channel, silent, false, undefined, undefined, method, partOptions);
                    }
                    // Preset-less publish: post to the ad-hoc targets with the chosen author + method.
                    if (adhocChannel) {
                        await this.plugin.sendNoteToTelegram(this.file, adhocChannel, silent, false, undefined, undefined, adhocChannel.defaultMethod, partOptions);
                    }
                }
            });
    }

    onClose() {
        this.splitRenderComponent.unload();
        this.contentEl.empty();
    }
}

// ─── Chat suggest ─────────────────────────────────────────────────────────────

class ChatSuggest extends AbstractInputSuggest<DialogData> {
    private loader: () => Promise<DialogData[]>;
    private excluded: () => Array<{ id: string; topicId?: number }>;
    onPick: (dialog: DialogData) => Promise<void> = async () => {};

    constructor(
        app: App,
        inputEl: HTMLInputElement,
        loader: () => Promise<DialogData[]>,
        excluded: () => Array<{ id: string; topicId?: number }>,
    ) {
        super(app, inputEl);
        this.limit = 300;
        this.loader = loader;
        this.excluded = excluded;
    }

    async getSuggestions(query: string): Promise<DialogData[]> {
        const dialogs = await this.loader();
        const targets = this.excluded();
        const available = dialogs.filter(d =>
            !targets.some(t => t.id === d.id && t.topicId === d.topicId)
        );
        const q = query.toLowerCase();
        return q
            ? available.filter(d => d.title.toLowerCase().includes(q))
            : available;
    }

    renderSuggestion(dialog: DialogData, el: HTMLElement): void { el.setText(dialog.title); }

    selectSuggestion(dialog: DialogData, _evt: MouseEvent | KeyboardEvent): void {
        void this.onPick(dialog);
        this.setValue("");
        this.close();
    }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

export class TelegramSettingTab extends PluginSettingTab {
    plugin: SendToTelegramPlugin;
    private inlineQrClient: TelegramClient | null = null;
    private inlineLocalClient: TelegramClient | null = null;
    // Dialog lists are fetched lazily per account and cached for the tab's lifetime.
    private dialogsByAccount = new Map<string, { fetch: Promise<DialogData[]>; loading: boolean }>();
    // Persisted across re-renders so the credentials card stays open after edits.
    private credentialsCardOpen = false;
    // Container the tab last rendered into; re-renders target it so the declarative
    // wrapper (1.13.0+) or containerEl (older) stays stable. See render()/rerender().
    private renderRoot: HTMLElement | null = null;

    constructor(app: App, plugin: SendToTelegramPlugin) { super(app, plugin); this.plugin = plugin; }

    // Declarative settings API (Obsidian 1.13.0+). Returning a non-empty array makes
    // Obsidian render the tab from these definitions (and index them for the settings
    // search) instead of calling display(). This tab is fully custom and dynamic
    // (auth cards, preset cards, inline forms), so it can't be expressed as declarative
    // control definitions — a single render escape-hatch reuses the imperative renderer,
    // while name/aliases make the plugin's settings discoverable in the settings search.
    getSettingDefinitions(): SettingDefinitionItem[] {
        return [{
            name: t.SETTING_HEADER,
            desc: t.SETTING_DESCRIPTION,
            aliases: [
                t.SECTION_GENERAL, t.SECTION_PRESETS, t.SETTING_ADD_CHANNEL_NAME,
                t.SETTING_SAVE_POST_LINKS_NAME, t.SETTING_MD_EMBEDS_AS_COMMENTS_NAME,
                t.SETTING_ALWAYS_SILENT_NAME,
                t.SETTING_ADD_PRESET, t.SETTING_FORMATTING_HELP,
                t.AUTH_LOGIN_BTN, t.AUTH_ADD_ACCOUNT_BTN, t.AUTH_ADD_BOT_TOKEN_BTN,
                t.AUTH_MANAGE_CREDENTIALS_BTN,
            ],
            render: (setting, group) => {
                // Keep the definition's own row as a collapsed search anchor (the settings
                // search still scrolls to it) and build the full imperative UI beneath it,
                // into a dedicated child container so render()'s empty() never wipes it.
                setting.settingEl.addClass("telegram-settings-anchor");
                this.render(group.listEl.createDiv("telegram-settings-root"));
            },
        }];
    }

    // display() is the fallback for Obsidian < 1.13.0 (minAppVersion 1.11.4), which
    // does not call getSettingDefinitions().
    display(): void { this.render(); }

    // Re-renders after a state change into whichever container we last rendered into:
    // the declarative group's child on 1.13.0+, or this.containerEl on the display()
    // fallback. This keeps the declarative wrapper and search anchor intact without
    // touching the 1.13.0-only update() API.
    private rerender(): void {
        this.render(this.renderRoot ?? this.containerEl);
    }

    private render(root: HTMLElement = this.containerEl): void {
        this.renderRoot = root;
        if (this.inlineQrClient) {
            this.inlineQrClient.disconnect().catch(() => {});
            this.inlineQrClient = null;
        }
        if (this.inlineLocalClient) {
            this.inlineLocalClient.disconnect().catch(() => {});
            this.inlineLocalClient = null;
        }
        const containerEl = root;
        containerEl.empty();

        new Setting(containerEl).setHeading().setName(t.SETTING_HEADER);

        containerEl.createEl("p", { text: t.SETTING_DESCRIPTION, cls: "telegram-plugin-description" });

        // ── Changelog banner ──
        const currentVersion = this.plugin.manifest.version;
        if (this.plugin.settings.dismissedChangelogVersion !== currentVersion) {
            const bannerEl = containerEl.createDiv({ cls: "telegram-changelog-banner" });
            const textEl = bannerEl.createSpan({ cls: "telegram-changelog-banner-text" });
            textEl.appendText(t.CHANGELOG_BANNER_PREFIX);
            const versionBtn = textEl.createEl("button", {
                text: currentVersion,
                cls: "telegram-changelog-version-link",
            });
            versionBtn.addEventListener("click", () => {
                new ChangelogModal(this.app, getChangelogContent()).open();
            });
            const closeBtn = bannerEl.createEl("button", {
                cls: "clickable-icon telegram-changelog-close",
                attr: { "aria-label": t.CHANGELOG_BANNER_DISMISS },
            });
            setIcon(closeBtn, "x");
            closeBtn.addEventListener("click", () => {
                this.plugin.settings.dismissedChangelogVersion = currentVersion;
                void this.plugin.saveSettings();
                bannerEl.remove();
            });
        }


      // ── General ──
      new Setting(containerEl).setHeading().setName(t.SECTION_GENERAL);

        const accounts = this.plugin.settings.accounts;
        const authStatusEl = containerEl.createDiv({ cls: "telegram-auth-status" });
        const authActionsEl = authStatusEl.createDiv({ cls: "telegram-auth-actions" });

        // Containers rendered just below the bar; revealed on demand by the buttons.
        const addTokenContainer = containerEl.createDiv({ cls: "telegram-auth-inline is-hidden" });
        const loginContainer = containerEl.createDiv({ cls: "telegram-auth-inline is-hidden" });
        const credsContainer = containerEl.createDiv({ cls: "telegram-auth-inline is-hidden" });
        const closeInline = () => {
            addTokenContainer.empty(); addTokenContainer.addClass("is-hidden");
            loginContainer.empty(); loginContainer.addClass("is-hidden");
            credsContainer.empty(); credsContainer.addClass("is-hidden");
            this.credentialsCardOpen = false;
            authActionsEl.querySelectorAll(".telegram-link-button.is-active")
                .forEach(el => el.classList.remove("is-active"));
        };

        // ButtonComponent's text and icon overwrite each other, so prepend the icon manually.
        const prependIcon = (btn: ButtonComponent, icon: string) => {
            setIcon(btn.buttonEl.createSpan({ cls: "telegram-btn-icon", prepend: true }), icon);
        };

        const loginBtn = new ButtonComponent(authActionsEl)
            .setButtonText(accounts.length > 0 ? t.AUTH_ADD_ACCOUNT_BTN : t.AUTH_LOGIN_BTN)
            .onClick(() => {
                const wasOpen = !loginContainer.hasClass("is-hidden");
                closeInline();
                if (!wasOpen) {
                    loginContainer.removeClass("is-hidden");
                    loginBtn.buttonEl.addClass("is-active");
                    this.renderInlinePhoneStep(loginContainer);
                }
            });
        loginBtn.buttonEl.addClass("telegram-link-button");
        prependIcon(loginBtn, "user-plus");

        const addTokenBtn = new ButtonComponent(authActionsEl)
            .setButtonText(t.AUTH_ADD_BOT_TOKEN_BTN)
            .onClick(() => {
                const wasOpen = !addTokenContainer.hasClass("is-hidden");
                closeInline();
                if (!wasOpen) {
                    addTokenContainer.removeClass("is-hidden");
                    addTokenBtn.buttonEl.addClass("is-active");
                    this.renderAddBotTokenForm(addTokenContainer);
                }
            });
        addTokenBtn.buttonEl.addClass("telegram-link-button");
        prependIcon(addTokenBtn, "bot-message-square");

        const openCredentials = () => {
            this.credentialsCardOpen = true;
            credsContainer.removeClass("is-hidden");
            credsBtn.buttonEl.addClass("is-active");
            this.renderCredentialsCard(credsContainer);
        };
        const credsBtn = new ButtonComponent(authActionsEl)
            .setButtonText(t.AUTH_MANAGE_CREDENTIALS_BTN)
            .setTooltip(t.AUTH_MANAGE_CREDENTIALS_TOOLTIP)
            .onClick(() => {
                const wasOpen = !credsContainer.hasClass("is-hidden");
                closeInline();
                if (!wasOpen) openCredentials();
            });
        credsBtn.buttonEl.addClass("telegram-link-button");
        prependIcon(credsBtn, "key-round");

        // Re-open the credentials card after a full re-render (e.g. following a
        // token delete or account logout triggered from inside the card).
        if (this.credentialsCardOpen) openCredentials();

        new Setting(containerEl).setName(t.SETTING_SAVE_POST_LINKS_NAME).setDesc(t.SETTING_SAVE_POST_LINKS_DESC)
            .addToggle(toggle => toggle.setValue(this.plugin.settings.savePostLinks)
                .onChange(async (v) => { this.plugin.settings.savePostLinks = v; await this.plugin.saveSettings(); }))
            .settingEl.addClass("telegram-bordered-setting");

        new Setting(containerEl).setName(t.SETTING_MD_EMBEDS_AS_COMMENTS_NAME).setDesc(t.SETTING_MD_EMBEDS_AS_COMMENTS_DESC)
            .addToggle(toggle => toggle.setValue(this.plugin.settings.treatMdEmbedsAsComments)
                .onChange(async (v) => { this.plugin.settings.treatMdEmbedsAsComments = v; await this.plugin.saveSettings(); }))
            .settingEl.addClass("telegram-bordered-setting");

        new Setting(containerEl).setName(t.SETTING_COMMENTS_FOLLOW_POST_NAME).setDesc(t.SETTING_COMMENTS_FOLLOW_POST_DESC)
            .addToggle(toggle => toggle.setValue(this.plugin.settings.commentsFollowPostSettings)
                .onChange(async (v) => { this.plugin.settings.commentsFollowPostSettings = v; await this.plugin.saveSettings(); }))
            .settingEl.addClass("telegram-bordered-setting");

        new Setting(containerEl).setName(t.SETTING_ALWAYS_SILENT_NAME).setDesc(t.SETTING_ALWAYS_SILENT_DESC)
            .addToggle(toggle => toggle.setValue(this.plugin.settings.alwaysSilent)
                .onChange(async (v) => { this.plugin.settings.alwaysSilent = v; await this.plugin.saveSettings(); }))
            .settingEl.addClass("telegram-bordered-setting");

        // ── Presets ──
        new Setting(containerEl).setHeading().setName(t.SECTION_PRESETS);

        const addSection = containerEl.createDiv("telegram-add-preset-section");
        const infoDiv = addSection.createDiv("telegram-add-preset-info");
        infoDiv.createDiv({ text: t.SETTING_ADD_CHANNEL_NAME, cls: "telegram-add-preset-title" });
        infoDiv.createDiv({ text: t.SETTING_ADD_CHANNEL_DESC, cls: "telegram-add-preset-description" });

        const linkRow = addSection.createDiv("telegram-add-preset-button-row");

        new ButtonComponent(linkRow)
            .setButtonText(t.SETTING_OPEN_USERINFOBOT)
            .onClick(() => { window.open("https://t.me/userinfobot", "_blank"); })
            .buttonEl.addClass("telegram-link-button");

        new ButtonComponent(linkRow)
            .setButtonText(t.SETTING_OPEN_BOTFATHER)
            .onClick(() => { window.open("https://t.me/BotFather", "_blank"); })
            .buttonEl.addClass("telegram-link-button");

        new ButtonComponent(linkRow)
            .setButtonText(t.SETTING_FORMATTING_HELP)
            .onClick(() => {
                new FormattingHelpModal(this.app, getUserGuideContent()).open();
            })
            .buttonEl.addClass("telegram-link-button");

        const addRow = addSection.createDiv("telegram-add-preset-button-row");

        new ButtonComponent(addRow)
            .setButtonText(t.SETTING_ADD_PRESET)
            .onClick(async () => {
                const existingNames = new Set(this.plugin.settings.channels.map(c => c.name));
                let idx = 1;
                while (existingNames.has(`${t.CHANNEL_DEFAULT_NAME} ${idx}`)) idx++;
                this.plugin.settings.channels.unshift({ id: Date.now().toString(), name: `${t.CHANNEL_DEFAULT_NAME} ${idx}`, defaultMethod: "account", chatTargets: [], chatId: "", isDefault: false });
                await this.plugin.saveSettings();
                this.rerender();
            }).buttonEl.addClass("telegram-add-button");

        this.plugin.settings.channels.forEach((channel, index) => {
            const channelDiv = containerEl.createDiv("telegram-channel-item");
            const header = channelDiv.createDiv("telegram-channel-header");
            const titleContainer = header.createDiv("telegram-header-title-container");
            titleContainer.createSpan({ text: channel.name || t.CHANNEL_DEFAULT_NAME, cls: "telegram-header-name" });

            new ButtonComponent(titleContainer.createDiv("telegram-edit-container"))
                .setIcon("pencil").onClick(() => {
                    titleContainer.empty();
                    const input = new TextComponent(titleContainer)
                        .setValue(channel.name)
                        .setPlaceholder(t.SETTING_PLACE_HOLDER_NAME);
                    input.inputEl.focus();

                    let saved = false;
                    const save = async () => {
                        if (saved) return;
                        saved = true;
                        channel.name = input.getValue();
                        await this.plugin.saveSettings();
                        this.rerender();
                    };

                    input.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
                        if (e.key === "Enter") { e.preventDefault(); void save(); }
                    });
                    input.inputEl.addEventListener("blur", voidListener(save));
                }).buttonEl.addClass("telegram-edit-button");

            new ButtonComponent(header.createDiv("telegram-delete-container"))
                .setIcon("trash").onClick(async () => {
                    new ConfirmationModal(
                        this.app,
                        t.CONFIRM_DELETE_TITLE,
                        t.CONFIRM_DELETE_MSG.replace("{name}", channel.name || t.CHANNEL_DEFAULT_NAME),
                        t.CONFIRM_DELETE_BTN,
                        async () => {
                            // Bot tokens are shared, named entities now — deleting a preset
                            // must not delete the token (managed via the credentials modal).
                            this.plugin.settings.channels.splice(index, 1);
                            await this.plugin.saveSettings();
                            this.rerender();
                        }
                    ).open();
                }).buttonEl.addClass("telegram-delete-button");

            // Primary publishing method, then the picker for that method's resource; an
            // optional "use secondary methods" toggle reveals the other method's picker.
            this.renderMethodField(channelDiv, channel);
            const primaryIsAccount = isAccountMethod(channel.defaultMethod ?? "account");
            if (primaryIsAccount) this.renderAccountField(channelDiv, channel);
            else this.renderBotTokenField(channelDiv, channel);

            this.renderSecondaryToggle(channelDiv, channel);
            if (channel.useSecondaryMethods) {
                if (primaryIsAccount) this.renderBotTokenField(channelDiv, channel);
                else this.renderAccountField(channelDiv, channel);
            }

            this.renderChatPicker(channelDiv, channel);

            new Setting(channelDiv).setName(t.SETTING_DEFAULT_CHANNEL).setDesc(t.SETTING_DEFAULT_DESC)
                .addToggle(toggle => {
                    toggle.setValue(channel.isDefault || false)
                        .onChange(async (v) => {
                            // Default is exclusive: clear every other preset, then set this one.
                            if (v) this.plugin.settings.channels.forEach(c => c.isDefault = false);
                            channel.isDefault = v;
                            await this.plugin.saveSettings();
                            // Re-render so all toggles reflect the new state. Calling
                            // setValue() here instead would re-enter onChange (Obsidian
                            // fires the change callback from setValue) and recurse.
                            this.rerender();
                        });
                })
                .settingEl.addClass("telegram-preset-default");
        });
    }

    private renderAccountField(container: HTMLElement, channel: TelegramChannel): void {
        const accounts = this.plugin.settings.accounts;
        // With exactly one account and no explicit choice, select it automatically.
        if (!channel.accountId && accounts.length === 1) {
            channel.accountId = accounts[0].id;
            void this.plugin.saveSettings();
        }
        const setting = new Setting(container)
            .setName(t.SETTING_ACCOUNT_NAME)
            .setDesc(accounts.length ? t.SETTING_ACCOUNT_DESC : t.SETTING_ACCOUNT_EMPTY_HINT);

        if (accounts.length > 0) {
            setting.addDropdown(dd => {
                dd.addOption("", t.SETTING_ACCOUNT_PLACEHOLDER);
                for (const acc of accounts) dd.addOption(acc.id, acc.displayName || acc.id);
                const current = accounts.some(a => a.id === channel.accountId) ? channel.accountId! : "";
                dd.setValue(current);
                dd.onChange(async (value) => {
                    channel.accountId = value || undefined;
                    await this.plugin.saveSettings();
                    // Re-render so the chat picker rebinds to the newly chosen account.
                    this.rerender();
                });
            });
        }
        setting.settingEl.addClass("telegram-account-setting");
    }

    private renderMethodField(container: HTMLElement, channel: TelegramChannel): void {
        const setting = new Setting(container)
            .setName(t.SETTING_METHOD_NAME)
            .setDesc(t.SETTING_METHOD_DESC)
            .addDropdown(dd => {
                for (const [value, label] of methodOptions()) dd.addOption(value, label);
                dd.setValue(channel.defaultMethod ?? "account");
                dd.onChange(async (value) => {
                    channel.defaultMethod = value as PostMethod;
                    await this.plugin.saveSettings();
                    // Re-render so the primary/secondary pickers reflect the new method.
                    this.rerender();
                });
            });
        setting.settingEl.addClass("telegram-method-setting");
    }

    private renderSecondaryToggle(container: HTMLElement, channel: TelegramChannel): void {
        new Setting(container)
            .setName(t.SETTING_SECONDARY_NAME)
            .setDesc(t.SETTING_SECONDARY_DESC)
            .addToggle(toggle => {
                toggle.setValue(channel.useSecondaryMethods ?? false)
                    .onChange(async (v) => {
                        channel.useSecondaryMethods = v;
                        await this.plugin.saveSettings();
                        // Re-render to show/hide the secondary method's picker.
                        this.rerender();
                    });
            })
            .settingEl.addClass("telegram-secondary-setting");
    }

    private renderBotTokenField(container: HTMLElement, channel: TelegramChannel): void {
        const tokens = this.plugin.settings.botTokens;
        // With exactly one saved bot and no explicit choice, select it automatically;
        // with multiple bots saved, leave the choice to the user.
        if (!channel.botTokenId && tokens.length === 1) {
            channel.botTokenId = tokens[0].id;
            channel.botToken = this.plugin.getBotTokenValue(tokens[0].id);
            void this.plugin.saveSettings();
        }
        const setting = new Setting(container)
            .setName(t.SETTING_BOT_TOKEN_SELECT_NAME)
            .setDesc(tokens.length ? t.SETTING_BOT_TOKEN_SELECT_DESC : t.SETTING_BOT_TOKEN_EMPTY_HINT);

        if (tokens.length > 0) {
            setting.addDropdown(dd => {
                dd.addOption("", t.SETTING_BOT_TOKEN_SELECT_PLACEHOLDER);
                for (const token of tokens) dd.addOption(token.id, token.name);
                // If the referenced token was deleted, fall back to the placeholder.
                const current = tokens.some(tk => tk.id === channel.botTokenId) ? channel.botTokenId! : "";
                dd.setValue(current);
                dd.onChange(async (value) => {
                    channel.botTokenId = value || undefined;
                    channel.botToken = value ? this.plugin.getBotTokenValue(value) : "";
                    await this.plugin.saveSettings();
                });
            });
        }
        setting.settingEl.addClass("telegram-bot-token-setting");
    }

    private renderAddBotTokenForm(container: HTMLElement): void {
        const card = container.createDiv({ cls: "telegram-add-token-form" });
        let tokenValue = "";

        const save = async (saveBtn: ButtonComponent) => {
            const token = tokenValue.trim();
            if (!token) { new Notice(t.BOT_TOKEN_INCOMPLETE); return; }
            saveBtn.setDisabled(true).setIcon("loader-2");
            try {
                // Resolve the bot's name from Telegram so the token is labelled automatically.
                const name = (await getBotInfo(token)) || t.BOT_TOKEN_DEFAULT_NAME;
                const id = Date.now().toString();
                this.plugin.settings.botTokens.push({ id, name });
                this.plugin.saveBotToken(id, token);
                await this.plugin.saveSettings();
                this.rerender();
            } catch (err) {
                saveBtn.setDisabled(false).setIcon("save");
                new Notice(`${t.BOT_TOKEN_INVALID}: ${errMessage(err)}`);
            }
        };

        // Token input and Save button share one row.
        const tokenSetting = new Setting(card)
            .setName(t.SETTING_BOT_TOKEN_NAME)
            .setDesc(t.SETTING_BOT_TOKEN_DESC)
            .addText(text => {
                text.inputEl.type = "password";
                text.setPlaceholder("123456789:abc…")
                    .onChange((v) => { tokenValue = v; });
            })
            .addButton(btn => {
                btn.setIcon("save").setTooltip(t.BOT_TOKEN_SAVE_BTN).setCta()
                    .onClick(() => { void save(btn); });
            });
        tokenSetting.settingEl.addClass("telegram-add-token-input");
    }

    // Inline equivalent of the old credentials modal: lists named bot tokens
    // (rename / delete) and connected accounts (log out). `refresh()` rebuilds the
    // card in place; mutations that affect the rest of the tab call this.rerender(),
    // which re-opens the card via credentialsCardOpen.
    private renderCredentialsCard(container: HTMLElement): void {
        const card = container.createDiv({ cls: "telegram-credentials-card" });

        // ── Bot tokens ──
        card.createDiv({ text: t.CREDENTIALS_BOT_TOKENS_HEADING, cls: "telegram-credentials-heading" });
        const tokens = this.plugin.settings.botTokens;
        if (tokens.length === 0) {
            card.createEl("p", { text: t.CREDENTIALS_NO_TOKENS, cls: "telegram-credentials-empty" });
        } else {
            const list = card.createDiv({ cls: "telegram-credentials-list" });
            for (const token of tokens) {
                const row = list.createDiv({ cls: "telegram-credentials-row" });
                row.createSpan({ text: token.name, cls: "telegram-credentials-row-name" });
                const rowActions = row.createDiv({ cls: "telegram-credentials-row-actions" });
                new ButtonComponent(rowActions)
                    .setIcon("pencil").setTooltip(t.CREDENTIALS_RENAME_TOKEN)
                    .onClick(() => this.renameCredential(token, row))
                    .buttonEl.addClass("clickable-icon");
                new ButtonComponent(rowActions)
                    .setIcon("trash").setTooltip(t.CREDENTIALS_DELETE_TOKEN_BTN)
                    .onClick(() => {
                        new ConfirmationModal(
                            this.app,
                            t.CREDENTIALS_DELETE_TOKEN_TITLE,
                            t.CREDENTIALS_DELETE_TOKEN_MSG.replace("{name}", token.name),
                            t.CREDENTIALS_DELETE_TOKEN_BTN,
                            async () => {
                                this.plugin.settings.botTokens = this.plugin.settings.botTokens.filter(tk => tk.id !== token.id);
                                this.plugin.deleteBotToken(token.id);
                                // Drop the reference from any preset that used this token.
                                for (const ch of this.plugin.settings.channels) {
                                    if (ch.botTokenId === token.id) { ch.botTokenId = undefined; ch.botToken = ""; }
                                }
                                await this.plugin.saveSettings();
                                this.rerender();
                            },
                        ).open();
                    })
                    .buttonEl.addClass("clickable-icon");
            }
        }

        // ── Accounts ──
        card.createDiv({ text: t.CREDENTIALS_ACCOUNT_HEADING, cls: "telegram-credentials-heading" });
        const accounts = this.plugin.settings.accounts;
        if (accounts.length === 0) {
            card.createEl("p", { text: t.AUTH_NOT_CONNECTED, cls: "telegram-credentials-empty" });
        } else {
            const list = card.createDiv({ cls: "telegram-credentials-list" });
            for (const account of accounts) {
                const row = list.createDiv({ cls: "telegram-credentials-row" });
                row.createSpan({ text: account.displayName || account.id, cls: "telegram-credentials-row-name" });
                const rowActions = row.createDiv({ cls: "telegram-credentials-row-actions" });
                new ButtonComponent(rowActions)
                    .setIcon("log-out").setTooltip(t.AUTH_LOGOUT_BTN)
                    .onClick(() => {
                        new ConfirmationModal(
                            this.app,
                            t.CONFIRM_LOGOUT_TITLE,
                            t.CONFIRM_LOGOUT_MSG.replace("{name}", account.displayName || account.id),
                            t.CONFIRM_LOGOUT_BTN,
                            async () => {
                                this.plugin.removeAccount(account.id);
                                await this.plugin.saveSettings();
                                this.rerender();
                            },
                        ).open();
                    })
                    .buttonEl.addClass("clickable-icon");
            }
        }
    }

    private renameCredential(token: BotToken, row: HTMLElement): void {
        row.empty();
        const input = new TextComponent(row);
        input.setValue(token.name);
        input.inputEl.addClass("telegram-credentials-rename-input");
        input.inputEl.focus();
        input.inputEl.select();

        let saved = false;
        const save = async () => {
            if (saved) return;
            saved = true;
            const v = input.getValue().trim();
            if (v) {
                token.name = v;
                await this.plugin.saveSettings();
            }
            this.rerender();
        };

        input.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter") { e.preventDefault(); void save(); }
            else if (e.key === "Escape") { saved = true; this.rerender(); }
        });
        input.inputEl.addEventListener("blur", voidListener(save));
    }

    private renderChatPicker(container: HTMLElement, channel: TelegramChannel): void {
        const pickerEl = container.createDiv("telegram-chat-picker");
        const fieldEl = pickerEl.createDiv("telegram-chat-picker-field");
        let activeSuggest: ChatSuggest | null = null;

        const renderField = () => {
            activeSuggest?.close();
            activeSuggest = null;
            fieldEl.empty();

            // Chips for each target
            for (const target of (channel.chatTargets ?? [])) {
                const chip = fieldEl.createSpan({ cls: "telegram-chat-chip" });
                chip.createSpan({ text: target.title || target.id, cls: "telegram-chat-chip-text" });
                const removeBtn = chip.createEl("button", { cls: "telegram-chat-chip-remove" });
                setIcon(removeBtn, "x");
                // Mirror the X-button hover onto the chip text (replaces a :has() selector)
                removeBtn.addEventListener("mouseenter", () => chip.classList.add("remove-hover"));
                removeBtn.addEventListener("mouseleave", () => chip.classList.remove("remove-hover"));
                removeBtn.addEventListener("click", voidListener(async (e: MouseEvent) => {
                    e.stopPropagation();
                    channel.chatTargets = (channel.chatTargets ?? []).filter(t => !(t.id === target.id && t.topicId === target.topicId));
                    channel.chatId = channel.chatTargets[0]?.id ?? "";
                    channel.chatTitle = channel.chatTargets[0]?.title;
                    await this.plugin.saveSettings();
                    renderField();
                }));
            }

            // Always-visible input at the end
            const input = fieldEl.createEl("input", { cls: "telegram-chat-search" });
            input.type = "text";
            const hasChips = (channel.chatTargets?.length ?? 0) > 0;
            // Shrink the input to sit inline after chips (replaces a :has() selector)
            fieldEl.classList.toggle("has-chips", hasChips);
            // Chats are suggested from the preset's chosen account (no fetch until one is
            // picked). Manual @username/ID entry stays available regardless — needed for
            // bot-method presets used without an account.
            const suggestAccountId = this.plugin.settings.accounts.some(a => a.id === channel.accountId)
                ? channel.accountId : undefined;
            const needsAccountChoice = !suggestAccountId && this.plugin.settings.accounts.length > 0;

            input.placeholder = hasChips ? "" : (
                needsAccountChoice ? t.SETTING_CHOOSE_ACCOUNT_FIRST :
                !suggestAccountId ? t.SETTING_PLACEHOLDER_CHAT :
                this.dialogsFor(suggestAccountId).loading ? t.SETTING_CHAT_PICKER_LOADING :
                t.SETTING_PLACEHOLDER_CHAT_SEARCH
            );

            if (suggestAccountId) {
                const accountId = suggestAccountId;
                const suggest = new ChatSuggest(
                    this.app, input,
                    () => this.dialogsFor(accountId).fetch,
                    () => channel.chatTargets ?? [],
                );
                activeSuggest = suggest;
                input.addEventListener("focus", () => {
                    const entry = this.dialogsFor(accountId);
                    if (entry.loading) {
                        // Wait for data before opening — avoids showing an empty dropdown
                        void entry.fetch.then(() => {
                            if (activeDocument.activeElement === input) suggest.open();
                        });
                    } else {
                        suggest.open();
                    }
                });
                suggest.onPick = async (dialog: DialogData) => {
                    const isDupe = (channel.chatTargets ?? []).some(
                        t => t.id === dialog.id && t.topicId === dialog.topicId
                    );
                    if (!isDupe) {
                        if (!channel.chatTargets) channel.chatTargets = [];
                        channel.chatTargets.push({ id: dialog.id, title: dialog.title, topicId: dialog.topicId });
                        channel.chatId = channel.chatTargets[0]?.id ?? "";
                        channel.chatTitle = channel.chatTargets[0]?.title;
                        channel.topicId = channel.chatTargets[0]?.topicId;
                        await this.plugin.saveSettings();
                    }
                    renderField();
                };
            }

            // Manual entry: Enter adds an @username/ID chip. Registered after the suggest's
            // own keydown so it fires second — if the suggest selected an item it already
            // cleared the input, so input.value is empty here and we skip.
            input.addEventListener("keydown", voidListener(async (e: KeyboardEvent) => {
                if (e.key !== "Enter") return;
                const id = input.value.trim();
                if (!id) return;
                e.preventDefault();
                if ((channel.chatTargets ?? []).some(t => t.id === id)) { renderField(); return; }
                if (!channel.chatTargets) channel.chatTargets = [];
                channel.chatTargets.push({ id });
                channel.chatId = channel.chatTargets[0]?.id ?? "";
                channel.chatTitle = channel.chatTargets[0]?.title;
                await this.plugin.saveSettings();
                renderField();
                fieldEl.querySelector<HTMLInputElement>(".telegram-chat-search")?.focus();
            }));
        };

        // Clicking the field background focuses the input
        fieldEl.addEventListener("click", (e: MouseEvent) => {
            if (!(e.target as HTMLElement).closest(".telegram-chat-chip-remove")) {
                fieldEl.querySelector<HTMLInputElement>(".telegram-chat-search")?.focus();
            }
        });

        renderField();
    }

    // Returns (creating + caching on first use) the dialog-fetch state for an account.
    // One fetch per account for the tab's lifetime; presets sharing an account share it.
    private dialogsFor(accountId: string): { fetch: Promise<DialogData[]>; loading: boolean } {
        const cached = this.dialogsByAccount.get(accountId);
        if (cached) return cached;
        const secrets = this.plugin.getAccountSecrets(accountId);
        const entry: { fetch: Promise<DialogData[]>; loading: boolean } = { fetch: Promise.resolve([]), loading: true };
        entry.fetch = (async () => {
            const client = await createClient(
                secrets.telegramSession, secrets.telegramApiId, secrets.telegramApiHash
            ).catch(() => null);
            const dialogs = client ? await getUserDialogs(client) : [];
            if (client) await this.backfillIdentity(accountId, client);
            await client?.destroy().catch(() => {});
            entry.loading = false;
            this.containerEl.querySelectorAll<HTMLInputElement>('.telegram-chat-search').forEach(input => {
                if (input.placeholder === t.SETTING_CHAT_PICKER_LOADING) {
                    input.placeholder = t.SETTING_PLACEHOLDER_CHAT_SEARCH;
                }
            });
            return dialogs;
        })();
        this.dialogsByAccount.set(accountId, entry);
        return entry;
    }

    private buildAuthCard(
        container: HTMLElement,
        title: string,
        onBack?: () => void
    ): { fields: HTMLElement; submitEl: HTMLButtonElement; noteEl: HTMLParagraphElement; extraEl: HTMLElement } {
        container.empty();
        const card = container.createDiv({ cls: "telegram-auth-card" });

        const header = card.createDiv({ cls: "telegram-auth-header" });
        const backBtn = header.createEl("button", { cls: "telegram-auth-back" });
        setIcon(backBtn, "arrow-left");
        if (onBack) {
            backBtn.addEventListener("click", onBack);
        } else {
            backBtn.addClass("is-hidden");
        }
        header.createDiv({ text: title, cls: "telegram-auth-title" });
        header.createDiv();

        const fields = card.createDiv({ cls: "telegram-auth-fields" });
        const submitEl = card.createEl("button", { cls: "telegram-auth-submit" });
        const noteEl = card.createEl("p", { cls: "telegram-auth-note" });
        const extraEl = card.createDiv();

        return { fields, submitEl, noteEl, extraEl };
    }

    // Primary auth entry point: phone number + code, using bundled API credentials.
    private renderInlinePhoneStep(container: HTMLElement): void {
        const { fields, submitEl, noteEl, extraEl } = this.buildAuthCard(container, t.AUTH_STEP_1);

        let phoneValue = "";
        const phoneInput = fields.createEl("input", { cls: "telegram-auth-input", attr: { type: "tel", placeholder: t.AUTH_PHONE_PLACEHOLDER } });
        phoneInput.addEventListener("input", () => { phoneValue = phoneInput.value; });
        phoneInput.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); submitEl.click(); } });
        window.setTimeout(() => phoneInput.focus(), 50);

        submitEl.textContent = t.AUTH_SEND_CODE_BTN;
        submitEl.addEventListener("click", voidListener(async () => {
            if (!phoneValue.trim()) return;
            submitEl.disabled = true;
            submitEl.textContent = t.AUTH_LOADING;
            try {
                if (this.inlineLocalClient) {
                    await this.inlineLocalClient.destroy();
                    this.inlineLocalClient = null;
                }
                this.inlineLocalClient = await buildClient(undefined, AUTH_API_ID, AUTH_API_HASH);
                await this.inlineLocalClient.connect();
                const result = await this.inlineLocalClient.sendCode({ phone: phoneValue.trim() });
                if (!("phoneCodeHash" in result)) throw new Error("Already signed in");
                this.renderInlineLocalCodeStep(container, { phone: phoneValue.trim(), apiId: AUTH_API_ID, apiHash: AUTH_API_HASH, phoneCodeHash: result.phoneCodeHash });
            } catch (err) {
                submitEl.disabled = false;
                submitEl.textContent = t.AUTH_SEND_CODE_BTN;
                new Notice(`${t.AUTH_ERROR}: ${errMessage(err)}`);
            }
        }));

        noteEl.textContent = t.AUTH_PHONE_NOTE;

        const qrBtn = extraEl.createEl("button", { cls: "telegram-auth-link-btn", text: t.AUTH_PHONE_USE_QR });
        qrBtn.addEventListener("click", () => this.renderInlineQrStep(container));
    }

    private renderInlineQrStep(container: HTMLElement): void {
        if (this.inlineQrClient) {
            this.inlineQrClient.destroy().catch(() => {});
            this.inlineQrClient = null;
        }

        const { fields, submitEl, noteEl, extraEl } = this.buildAuthCard(container, t.AUTH_QR_TITLE,
            () => this.renderInlinePhoneStep(container));
        submitEl.addClass("is-hidden");

        const qrWrap = fields.createDiv({ cls: "telegram-qr-wrap" });
        qrWrap.createSpan({ text: t.AUTH_LOADING, cls: "telegram-qr-loading" });

        noteEl.textContent = t.AUTH_QR_NOTE;

        const linkBtn = extraEl.createEl("button", { cls: "telegram-auth-link-btn", text: t.AUTH_QR_USE_PHONE });
        linkBtn.addEventListener("click", () => {
            if (this.inlineQrClient) {
                this.inlineQrClient.destroy().catch(() => {});
                this.inlineQrClient = null;
            }
            this.renderInlinePhoneStep(container);
        });

        // Renders a QR code SVG from the login URL mtcute hands us.
        const showQr = async (url: string): Promise<void> => {
            const svgStr = await QRCode.toString(url, { type: "svg", margin: 1 });
            qrWrap.empty();
            const parser = new DOMParser();
            const svgDoc = parser.parseFromString(svgStr, "image/svg+xml");
            qrWrap.appendChild(svgDoc.documentElement);
        };

        // mtcute's signInQr drives the whole ExportLoginToken/scan/DC-migration handshake
        // internally. 2FA is handled by the `password` callback: we render the password step
        // and resolve it when the user submits (a wrong password re-invokes the callback).
        void (async () => {
            const client = await buildClient(undefined, AUTH_API_ID, AUTH_API_HASH);
            this.inlineQrClient = client;
            try {
                await client.connect();
                await client.signInQr({
                    onUrlUpdated: (url) => { void showQr(url); },
                    password: () => new Promise<string>((resolve) => {
                        this.renderInlineQrPasswordStep(container, resolve);
                    }),
                    invalidPasswordCallback: () => { new Notice(`${t.AUTH_ERROR}: ${t.AUTH_PASSWORD_REQUIRED}`); },
                });
                if (this.inlineQrClient) await this.saveMtcuteSession(client, AUTH_API_ID, AUTH_API_HASH);
            } catch (err) {
                if (this.inlineQrClient) new Notice(`${t.AUTH_ERROR}: ${errMessage(err)}`);
            }
        })();
    }

    // Renders the 2FA password step and hands the entered password back via `onSubmit`.
    // Used as the resolver for signInQr's `password` callback (and the phone flow).
    private renderInlineQrPasswordStep(container: HTMLElement, onSubmit: (password: string) => void): void {
        const { fields, submitEl, noteEl } = this.buildAuthCard(container, t.AUTH_STEP_2);

        let passwordValue = "";
        const passwordInput = fields.createEl("input", { cls: "telegram-auth-input", attr: { type: "password", placeholder: t.AUTH_PASSWORD_PLACEHOLDER } });
        passwordInput.addEventListener("input", () => { passwordValue = passwordInput.value; });
        passwordInput.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); submitEl.click(); } });
        window.setTimeout(() => passwordInput.focus(), 50);

        submitEl.textContent = t.AUTH_VERIFY_BTN;
        submitEl.addEventListener("click", () => {
            if (!passwordValue.trim()) return;
            submitEl.disabled = true;
            submitEl.textContent = t.AUTH_LOADING;
            onSubmit(passwordValue.trim());
        });

        noteEl.textContent = t.AUTH_PASSWORD_REQUIRED;
    }

    // Accounts authorized before user ids were recorded carry no `userId`. Fill it in
    // whenever we already have a live client for one, so a re-login is recognized as the
    // same account rather than added alongside it.
    private async backfillIdentity(accountId: string, client: TelegramClient): Promise<void> {
        const acc = this.plugin.settings.accounts.find(a => a.id === accountId);
        if (!acc || acc.userId !== undefined) return;
        const identity = await this.resolveIdentity(client);
        if (identity.userId === undefined) return;
        acc.userId = identity.userId;
        await this.plugin.saveSettings();
    }

    // Terminates the stored session of an account we're about to overwrite, so the
    // superseded authorization stops showing up in Telegram's Devices list instead of
    // lingering there. Best-effort: an expired or already-revoked session just fails,
    // which is fine — we're discarding it either way.
    private async revokeSession(accountId: string): Promise<void> {
        const secrets = this.plugin.getAccountSecrets(accountId);
        if (!secrets.telegramSession) return;
        try {
            const old = await withTimeout(createClient(
                secrets.telegramSession, secrets.telegramApiId, secrets.telegramApiHash
            ), REVOKE_TIMEOUT_MS);
            try {
                // Bounded: an unreachable DC must not stall the login we're completing.
                await withTimeout(old.logOut(), REVOKE_TIMEOUT_MS);
            } finally {
                await old.destroy().catch(() => {});
            }
        } catch { /* session already dead or unreachable — nothing to revoke */ }
    }

    // Exports the mtcute string session for a freshly-authorized client and stores it.
    // Bundled credentials aren't persisted — the session alone reconnects.
    // Signing into an account that's already connected replaces that account's session
    // in place instead of adding a duplicate, so presets pointing at it keep working.
    private async saveMtcuteSession(client: TelegramClient, apiId: number, apiHash: string): Promise<void> {
        const identity = await this.resolveIdentity(client);
        const existing = identity.userId === undefined
            ? undefined
            : this.plugin.settings.accounts.find(a => a.userId === identity.userId);

        const session = await client.exportSession();
        const isBundled = apiId === AUTH_API_ID;
        const fields = {
            displayName: identity.displayName,
            apiId: isBundled ? 0 : apiId,
            apiHash: isBundled ? "" : apiHash,
            userId: identity.userId,
        };
        if (existing) {
            await this.revokeSession(existing.id);
            this.plugin.replaceAccount(existing.id, fields, session);
        } else {
            this.plugin.addAccount({ id: Date.now().toString(), ...fields }, session);
        }
        await client.destroy();
        this.inlineQrClient = null;
        this.inlineLocalClient = null;
        await this.plugin.saveSettings();
        new Notice(existing ? t.AUTH_RECONNECTED : t.AUTH_SUCCESS);
        this.rerender();
    }

    // Who the freshly-authorized client belongs to: label for the UI, plus the user id
    // the duplicate-login check compares against. Retried, because giving up here means
    // a re-login lands as a second account entry instead of replacing the first.
    private async resolveIdentity(client: TelegramClient): Promise<{ displayName: string; userId?: number }> {
        try {
            const me = await retry(() => client.getMe(), IDENTITY_ATTEMPTS, IDENTITY_RETRY_DELAY_MS);
            const parts = [me.firstName, me.lastName].filter(Boolean).join(" ");
            const username = me.username ? ` (@${me.username})` : "";
            return { displayName: `${parts}${username}`.trim(), userId: me.id };
        } catch {
            return { displayName: "" };
        }
    }

    private renderInlineLocalCodeStep(
        container: HTMLElement,
        state: { phone: string; apiId: number; apiHash: string; phoneCodeHash: string }
    ): void {
        const { fields, submitEl, noteEl } = this.buildAuthCard(
            container, t.AUTH_STEP_2,
            () => {
                if (this.inlineLocalClient) {
                    this.inlineLocalClient.disconnect().catch(() => {});
                    this.inlineLocalClient = null;
                }
                this.renderInlinePhoneStep(container);
            }
        );

        let codeValue = "";
        const codeInput = fields.createEl("input", { cls: "telegram-auth-input", attr: { type: "text", placeholder: t.AUTH_CODE_PLACEHOLDER } });
        codeInput.addEventListener("input", () => { codeValue = codeInput.value; });
        codeInput.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); submitEl.click(); } });
        window.setTimeout(() => codeInput.focus(), 50);

        submitEl.textContent = t.AUTH_VERIFY_BTN;
        submitEl.addEventListener("click", voidListener(async () => {
            if (!codeValue.trim() || !this.inlineLocalClient) return;
            submitEl.disabled = true;
            submitEl.textContent = t.AUTH_LOADING;
            try {
                await this.inlineLocalClient.signIn({
                    phone: state.phone,
                    phoneCodeHash: state.phoneCodeHash,
                    phoneCode: codeValue.trim(),
                });
                await this.saveMtcuteSession(this.inlineLocalClient, state.apiId, state.apiHash);
            } catch (err) {
                if ((err as { text?: string }).text === "SESSION_PASSWORD_NEEDED" || errMessage(err).includes("SESSION_PASSWORD_NEEDED")) {
                    this.renderInlineLocalPasswordStep(container, state);
                } else {
                    submitEl.disabled = false;
                    submitEl.textContent = t.AUTH_VERIFY_BTN;
                    new Notice(`${t.AUTH_ERROR}: ${errMessage(err)}`);
                }
            }
        }));

        noteEl.textContent = t.AUTH_CODE_NOTE;
    }

    private renderInlineLocalPasswordStep(
        container: HTMLElement,
        state: { phone: string; apiId: number; apiHash: string; phoneCodeHash: string }
    ): void {
        const { fields, submitEl, noteEl } = this.buildAuthCard(
            container, t.AUTH_STEP_2,
            () => this.renderInlineLocalCodeStep(container, state)
        );

        let passwordValue = "";
        const passwordInput = fields.createEl("input", { cls: "telegram-auth-input", attr: { type: "password", placeholder: t.AUTH_PASSWORD_PLACEHOLDER } });
        passwordInput.addEventListener("input", () => { passwordValue = passwordInput.value; });
        passwordInput.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); submitEl.click(); } });
        window.setTimeout(() => passwordInput.focus(), 50);

        submitEl.textContent = t.AUTH_VERIFY_BTN;
        submitEl.addEventListener("click", voidListener(async () => {
            if (!passwordValue.trim() || !this.inlineLocalClient) return;
            submitEl.disabled = true;
            submitEl.textContent = t.AUTH_LOADING;
            try {
                await this.inlineLocalClient.checkPassword(passwordValue.trim());
                await this.saveMtcuteSession(this.inlineLocalClient, state.apiId, state.apiHash);
            } catch (err) {
                submitEl.disabled = false;
                submitEl.textContent = t.AUTH_VERIFY_BTN;
                new Notice(`${t.AUTH_ERROR}: ${errMessage(err)}`);
            }
        }));

        noteEl.textContent = t.AUTH_PASSWORD_REQUIRED;
    }
}
