import { App, Modal, Component, ButtonComponent, ToggleComponent, Notice, TFile, MarkdownRenderer, PluginSettingTab, Setting, TextComponent, DropdownComponent, setIcon, AbstractInputSuggest } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type { TelegramClient } from "@mtcute/web";
import { t, getUserGuideContent, getChangelogContent } from "../lang/helpers";
import type SendToTelegramPlugin from "../main";
import * as QRCode from "qrcode";
import { TelegramChannel, TelegramSecrets, BotToken, PostMethod } from "./types";
import { createClient, buildClient, getUserDialogs, DialogData, parseLinkComponents, AUTH_API_ID, AUTH_API_HASH } from "./telegram";
import { getBotInfo } from "./telegram-bot";
import { errMessage, retry, withTimeout } from "./util";

// How long to wait on each network step of revoking a superseded session (connect,
// then log out) before giving up and completing the login regardless.
const REVOKE_TIMEOUT_MS = 8000;

// getMe() identifies the account that just signed in; a transient failure there would
// strand a re-login as a duplicate entry, so it's worth a couple of retries.
const IDENTITY_ATTEMPTS = 3;
const IDENTITY_RETRY_DELAY_MS = 1000;

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
        const chat = await client.getChat(entity);
        let title = chat.displayName || (chat.username ? `@${chat.username}` : null);
        const isChannel = chat.chatType === "channel";
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

    private silentToggle: ToggleComponent;
    private silentOptionEl: HTMLElement | null = null;
    private attachToggle: ToggleComponent;
    private attachOptionEl: HTMLElement | null = null;
    private scheduleInput: HTMLInputElement | null = null;
    // Guards programmatic preset-toggle changes so radio-style selection (only one
    // preset at a time) doesn't re-enter the toggle's own onChange handler.
    private updatingPresets = false;

    private updateLinkDropdown: DropdownComponent | null = null;
    private updateHintEl: HTMLElement | null = null;
    private updateDescEl: HTMLElement | null = null;
    private builtUpdateChannel: TelegramChannel | null = null;

    private commentLinkDropdown: DropdownComponent | null = null;

    private publishBtn: ButtonComponent | null = null;
    private channelRows: Array<{ id: string, container: HTMLElement, toggle: ToggleComponent, method: PostMethod, methodsEl: HTMLElement }> = [];
    private scheduleOptionEl: HTMLElement | null = null;
    private resolvedLinks = new Map<string, { title: string | null; isChannel: boolean }>();

    constructor(app: App, plugin: SendToTelegramPlugin, file: TFile, initialChannelId?: string) {
        super(app);
        this.plugin = plugin;
        this.file = file;
        this.selectedChannels = new Set();
        this.initialChannelId = initialChannelId;
    }

    private anyLinkSelected(): boolean {
        const post = this.updateLinkDropdown?.getValue() ?? "none";
        const comment = this.commentLinkDropdown?.getValue() ?? "none";
        return post !== "none" || comment !== "none";
    }

    private updatePublishBtn() {
        this.publishBtn?.setButtonText(this.anyLinkSelected() ? t.MULTI_PRESET_EDIT_BTN : t.MULTI_PRESET_POST_BTN);
    }

    private updateScheduleState() {
        if (!this.scheduleOptionEl || !this.scheduleInput) return;
        // Scheduling isn't supported by the Bot API, and editing an existing post/comment
        // can't be scheduled either. Keep the field visible but disable it — both visually
        // (greyed, non-interactive) and physically (input disabled + value cleared) — when the
        // selected preset posts via a bot method, or when a link is selected for editing.
        const selectedRows = this.channelRows.filter(r => this.selectedChannels.has(r.id));
        const allBot = selectedRows.length > 0 && selectedRows.every(r => !isAccountMethod(r.method));
        const disabled = allBot || this.anyLinkSelected();
        this.scheduleInput.disabled = disabled;
        if (disabled) this.scheduleInput.value = "";
        this.scheduleOptionEl.toggleClass("is-disabled", disabled);
    }

    // A silent (no-sound) send only affects a new post's notification; editing an existing
    // post/comment doesn't re-notify, so the toggle is meaningless there — disable it (and
    // clear it) while a link is selected for editing.
    private updateSilentState() {
        if (!this.silentOptionEl) return;
        const editing = this.anyLinkSelected();
        this.silentToggle.setDisabled(editing);
        if (editing) this.silentToggle.setValue(false);
        this.silentOptionEl.toggleClass("is-disabled", editing);
    }

    // "Attachments below the text" only positions a caption above uploaded media. Rich
    // Messages embed media inside the markdown and can't carry local uploads at all, so
    // the option is meaningless there — disable it when a selected preset is a rich method.
    private updateAttachState() {
        if (!this.attachOptionEl) return;
        const anyRich = this.channelRows.some(r => this.selectedChannels.has(r.id) && isRichMethod(r.method));
        this.attachToggle.setDisabled(anyRich);
        if (anyRich) this.attachToggle.setValue(false);
        this.attachOptionEl.toggleClass("is-disabled", anyRich);
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

    // Collects the normalized chat ids of the links currently chosen for editing.
    // Returns null when an "all" bulk option is chosen (no single chat to match against).
    private editingChatIds(): Set<string> | null {
        const ids = new Set<string>();
        const post = this.updateLinkDropdown?.getValue() ?? "none";
        if (post === "all") return null;
        if (post !== "none") {
            const parsed = parseLinkComponents(post);
            if (parsed) ids.add(normChatId(parsed.chatId));
        }
        const comment = this.commentLinkDropdown?.getValue() ?? "none";
        if (comment === "all") return null;
        if (comment !== "none") ids.add(normChatId(comment)); // comment option value is the chat id
        return ids;
    }

    // Reflects the current edit-link selection on the preset rows: enables only the
    // presets whose chat targets match the chosen link's chat (all disabled for the
    // "all" bulk option). The matching preset the user toggles on supplies the method
    // and token used to perform the edit. With no link selected every preset is re-enabled.
    private applyEditLinkFilter() {
        const editing = this.anyLinkSelected();

        if (!editing) {
            this.channelRows.forEach(row => row.container.removeClass("is-disabled"));
        } else {
            const chatIds = this.editingChatIds();
            this.channelRows.forEach(row => {
                const channel = this.plugin.settings.channels.find(c => c.id === row.id);
                const matches = chatIds !== null && !!channel
                    && (channel.chatTargets ?? []).some(target => chatIds.has(normChatId(target.id)));
                if (matches) {
                    row.container.removeClass("is-disabled");
                } else {
                    row.container.addClass("is-disabled");
                    if (this.selectedChannels.has(row.id)) {
                        // Untoggle just this row (radio selection would otherwise cascade).
                        this.updatingPresets = true;
                        row.toggle.setValue(false);
                        row.methodsEl.toggleClass("is-hidden", true);
                        this.selectedChannels.delete(row.id);
                        this.updatingPresets = false;
                    }
                }
            });
        }
        // Refresh the option states on every link change (both when a link is picked and when
        // it's cleared): scheduling and the silent toggle don't apply to edits.
        this.updateScheduleState();
        this.updateAttachState();
        this.updateSilentState();
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
    // it falls back to the account path (channelFromLink).
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
        } else if (title) {
            const channel = channelFromLink(link, title);
            if (channel) await this.plugin.sendNoteToTelegram(this.file, channel, silent, attachUnderText, link, undefined);
        }
    }

    private showHint(el: HTMLElement | null, descEl: HTMLElement | null, text: string, isError: boolean) {
        if (!el) return;
        el.setText(text);
        el.show();
        descEl?.hide();
        if (isError) el.addClass("is-error");
        else el.removeClass("is-error");
    }

    private hideHint(el: HTMLElement | null, descEl: HTMLElement | null) {
        el?.hide();
        descEl?.show();
    }

    private handleLinkSelection(value: string) {
        this.updatePublishBtn();
        this.applyEditLinkFilter();
        if (value === "none") {
            this.builtUpdateChannel = null;
            this.hideHint(this.updateHintEl, this.updateDescEl);
            return;
        }

        if (value === "all") {
            this.builtUpdateChannel = null;
            this.hideHint(this.updateHintEl, this.updateDescEl);
            return;
        }

        const info = this.resolvedLinks.get(value);
        if (info?.title) {
            this.builtUpdateChannel = channelFromLink(value, info.title);
            this.showHint(this.updateHintEl, this.updateDescEl, t.MULTI_PRESET_UPDATE_WILL_USE.replace("{name}", info.title), false);
        } else {
            this.builtUpdateChannel = null;
            this.showHint(this.updateHintEl, this.updateDescEl, t.MULTI_PRESET_UPDATE_NO_MATCH, true);
        }
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText(t.MULTI_PRESET_TITLE);

        if (this.plugin.settings.channels.length === 0) {
            contentEl.createEl("p", { text: t.NOTICE_ERR_CONFIG });
            return;
        }

        contentEl.createDiv({
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

        this.silentOptionEl = contentEl.createDiv("telegram-option-item");
        const silentOptionEl = this.silentOptionEl;
        const silentTextEl = silentOptionEl.createDiv("telegram-option-text");
        silentTextEl.createDiv({ text: t.MULTI_PRESET_SILENT_POST_NAME, cls: "telegram-option-name" });
        silentTextEl.createDiv({ text: t.MULTI_PRESET_SILENT_POST_DESC, cls: "telegram-option-desc" });
        this.silentToggle = new ToggleComponent(silentOptionEl.createDiv("telegram-option-control"))
            .setValue(false);

        this.attachOptionEl = contentEl.createDiv("telegram-option-item");
        const attachTextEl = this.attachOptionEl.createDiv("telegram-option-text");
        attachTextEl.createDiv({ text: t.MULTI_PRESET_ATTACHMENTS_NAME, cls: "telegram-option-name" });
        attachTextEl.createDiv({ text: t.MULTI_PRESET_ATTACHMENTS_DESC, cls: "telegram-option-desc" });
        this.attachToggle = new ToggleComponent(this.attachOptionEl.createDiv("telegram-option-control"))
            .setValue(false);

        this.scheduleOptionEl = contentEl.createDiv("telegram-option-item");
        const scheduleOptionEl = this.scheduleOptionEl;
        const scheduleTextEl = scheduleOptionEl.createDiv("telegram-option-text");
        scheduleTextEl.createDiv({ text: t.MULTI_PRESET_SCHEDULE_NAME, cls: "telegram-option-name" });
        scheduleTextEl.createDiv({ text: t.MULTI_PRESET_SCHEDULE_DESC, cls: "telegram-option-desc" });
        this.scheduleInput = scheduleOptionEl.createDiv("telegram-option-control").createEl("input", { cls: "telegram-schedule-input" });
        this.scheduleInput.type = "datetime-local";

        // Initial state now that all option elements exist.
        this.updateScheduleState();
        this.updateAttachState();
        this.updateSilentState();

        // ─── Edit Post & Comments Section ─────────────────────────────────────────────

        const cache = this.app.metadataCache.getFileCache(this.file);
        const readLinks = (key: string): string[] => {
            const raw: unknown = cache?.frontmatter?.[key];
            return Array.isArray(raw) ? raw.map(String) : (typeof raw === 'string' ? [raw] : []);
        };
        const allStoredPostLinks = readLinks("tg_posts");
        const allStoredCommentLinks = readLinks("tg_comments");

        contentEl.createDiv({ text: t.MULTI_PRESET_UPDATE_HEADING, cls: "telegram-modal-heading" });

        // "Update existing post" row
        const updateOptionEl = contentEl.createDiv("telegram-option-item telegram-option-item--edit");
        const updateTextEl = updateOptionEl.createDiv("telegram-option-text");
        updateTextEl.createDiv({ text: t.MULTI_PRESET_UPDATE_NAME, cls: "telegram-option-name" });
        this.updateDescEl = updateTextEl.createDiv({ text: t.MULTI_PRESET_UPDATE_NAME_DESC, cls: "telegram-option-desc" });
        this.updateHintEl = updateTextEl.createDiv({ cls: "telegram-update-channel-hint" });
        this.updateHintEl.hide();
        const updateControlEl = updateOptionEl.createDiv("telegram-option-control");

        // "Edit existing comments" row
        const commentOptionEl = contentEl.createDiv("telegram-option-item telegram-option-item--edit");
        const commentTextEl = commentOptionEl.createDiv("telegram-option-text");
        commentTextEl.createDiv({ text: t.MULTI_PRESET_EDIT_COMMENTS_NAME, cls: "telegram-option-name" });
        commentTextEl.createDiv({ text: t.MULTI_PRESET_EDIT_COMMENTS_DESC, cls: "telegram-option-desc" });
        const commentControlEl = commentOptionEl.createDiv("telegram-option-control");

        const hasAnyLinks = allStoredPostLinks.length > 0 || allStoredCommentLinks.length > 0;
        if (!hasAnyLinks || this.plugin.settings.accounts.length === 0) {
            updateTextEl.createDiv({ text: t.MULTI_PRESET_UPDATE_NO_LINKS, cls: "telegram-option-desc" });
            commentTextEl.createDiv({ text: t.MULTI_PRESET_EDIT_COMMENTS_NO_LINKS, cls: "telegram-option-desc" });
        } else {
            const updateLoadingEl = updateControlEl.createSpan({ text: t.MULTI_PRESET_UPDATE_RESOLVING, cls: "telegram-update-channel-hint" });
            const commentLoadingEl = commentControlEl.createSpan({ text: t.MULTI_PRESET_UPDATE_RESOLVING, cls: "telegram-update-channel-hint" });

            void (async () => {
                const allLinksToResolve = [...allStoredPostLinks, ...allStoredCommentLinks];
                const results = await Promise.all(
                    allLinksToResolve.map(link => fetchEntityInfo(link, this.plugin.secrets))
                );

                if (!updateLoadingEl.isConnected) return; // modal was closed before resolution

                allLinksToResolve.forEach((link, i) => {
                    if (results[i]) this.resolvedLinks.set(link, results[i]);
                });

                updateLoadingEl.remove();
                if (allStoredPostLinks.length > 0) {
                    this.updateLinkDropdown = new DropdownComponent(updateControlEl);
                    this.updateLinkDropdown.addOption("none", t.MULTI_PRESET_UPDATE_NO_OPTION);
                    if (allStoredPostLinks.length > 1) {
                        this.updateLinkDropdown.addOption("all", t.MULTI_PRESET_EDIT_COMMENTS_ALL_CHATS);
                    }
                    allStoredPostLinks.forEach(link => { this.updateLinkDropdown!.addOption(link, t.MULTI_PRESET_UPDATE_LINK_LABEL.replace("{link}", link)); });
                    this.updateLinkDropdown.setValue("none");
                    this.updateLinkDropdown.onChange(value => { this.handleLinkSelection(value); });
                } else {
                    updateTextEl.createDiv({ text: t.MULTI_PRESET_UPDATE_NO_LINKS, cls: "telegram-option-desc" });
                }

                commentLoadingEl.remove();
                if (allStoredCommentLinks.length > 0) {
                    const commentGroups = new Map<string, { links: string[]; title: string | null }>();
                    allStoredCommentLinks.forEach(link => {
                        const parsed = parseLinkComponents(link);
                        if (!parsed) return;
                        if (!commentGroups.has(parsed.chatId)) {
                            commentGroups.set(parsed.chatId, {
                                links: [],
                                title: this.resolvedLinks.get(link)?.title ?? null,
                            });
                        }
                        commentGroups.get(parsed.chatId)!.links.push(link);
                    });

                    this.commentLinkDropdown = new DropdownComponent(commentControlEl);
                    this.commentLinkDropdown.addOption("none", t.MULTI_PRESET_UPDATE_NO_OPTION);
                    if (commentGroups.size > 1) {
                        this.commentLinkDropdown.addOption("all", t.MULTI_PRESET_EDIT_COMMENTS_ALL_CHATS);
                    }
                    commentGroups.forEach((group, chatId) => {
                        this.commentLinkDropdown!.addOption(chatId, group.title ?? chatId);
                    });
                    this.commentLinkDropdown.setValue("none");
                    this.commentLinkDropdown.onChange(() => {
                        this.updatePublishBtn();
                        this.applyEditLinkFilter();
                    });
                } else {
                    commentTextEl.createDiv({ text: t.MULTI_PRESET_EDIT_COMMENTS_NO_LINKS, cls: "telegram-option-desc" });
                }
            })();
        }

        // ─── Publish Button ───────────────────────────────────────────────────────────

        const btnContainer = contentEl.createDiv("telegram-modal-buttons");
        this.publishBtn = new ButtonComponent(btnContainer)
            .setButtonText(t.MULTI_PRESET_POST_BTN)
            .setCta()
            .onClick(async () => {
                const updateLinkRaw = this.updateLinkDropdown?.getValue();
                const isUpdatingPost = !!updateLinkRaw && updateLinkRaw !== "none";
                const commentDropdownValue = this.commentLinkDropdown?.getValue();
                const isEditingComments = !!commentDropdownValue && commentDropdownValue !== "none";

                if (!isUpdatingPost && !isEditingComments && this.selectedChannels.size === 0) {
                    new Notice(t.MULTI_PRESET_NO_SELECTION);
                    return;
                }
                if (isUpdatingPost && updateLinkRaw !== "all" && !this.builtUpdateChannel) {
                    new Notice(t.MULTI_PRESET_UPDATE_NO_MATCH_NOTICE);
                    return;
                }

                const silent = this.silentToggle?.getValue() ?? false;
                const attachUnderText = this.attachToggle?.getValue() ?? false;

                let scheduleDate: Date | undefined;
                if (!isUpdatingPost && !isEditingComments && this.scheduleInput?.value) {
                    scheduleDate = new Date(this.scheduleInput.value);
                }

                this.close();

                if (isUpdatingPost) {
                    if (updateLinkRaw === "all") {
                        for (const link of allStoredPostLinks) {
                            const info = this.resolvedLinks.get(link);
                            if (!info?.title) continue;
                            await this.editPost(link, info.title, silent, attachUnderText);
                        }
                    } else {
                        await this.editPost(updateLinkRaw, this.resolvedLinks.get(updateLinkRaw)?.title ?? null, silent, attachUnderText);
                    }
                }
                if (isEditingComments) {
                    const commentGroupsByChatId = new Map<string, string[]>();
                    allStoredCommentLinks.forEach(link => {
                        const parsed = parseLinkComponents(link);
                        if (!parsed) return;
                        const group = commentGroupsByChatId.get(parsed.chatId) ?? [];
                        group.push(link);
                        commentGroupsByChatId.set(parsed.chatId, group);
                    });
                    commentGroupsByChatId.forEach(links => {
                        links.sort((a, b) => (parseLinkComponents(a)?.messageId ?? 0) - (parseLinkComponents(b)?.messageId ?? 0));
                    });

                    // Each comment chat routes by the preset selected for that chat: a bot /
                    // bot-rich preset edits via its bot, otherwise editing uses the account.
                    const editGroup = async (chatId: string, links: string[]) => {
                        const route = this.editRouteFor(chatId);
                        await this.plugin.editNoteComments(this.file, links, silent, route?.method ?? "account", route?.channel.botToken);
                    };

                    if (commentDropdownValue === "all") {
                        for (const [chatId, links] of commentGroupsByChatId.entries()) {
                            await editGroup(chatId, links);
                        }
                    } else {
                        const links = commentGroupsByChatId.get(commentDropdownValue) ?? [];
                        await editGroup(commentDropdownValue, links);
                    }
                }
                if (!isUpdatingPost && !isEditingComments) {
                    for (const channelId of this.selectedChannels) {
                        const channel = this.plugin.settings.channels.find(c => c.id === channelId);
                        const method = this.channelRows.find(r => r.id === channelId)?.method;
                        if (channel) await this.plugin.sendNoteToTelegram(this.file, channel, silent, attachUnderText, undefined, scheduleDate, method);
                    }
                }
            });
    }

    onClose() {
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
