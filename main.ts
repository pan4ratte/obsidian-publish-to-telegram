import { Plugin, Notice, TFile, TFolder, Menu } from "obsidian";
import { t, getUserGuideContent, getChangelogContent } from "./lang/helpers";
import { TelegramChannel, TelegramSettings, TelegramSecrets, TelegramAccount, PostMethod, DEFAULT_SETTINGS, PendingScheduledLink } from "./src/types";
import { sendNoteToTelegram, editNoteCommentsOnly, checkIsForum, createClient, resolveScheduledLinks, parseLinkComponents } from "./src/telegram";
import { sendNoteViaBotApi, editNoteCommentsViaBotApi } from "./src/telegram-bot";
import { ChangelogModal, FormattingHelpModal, MultiPresetModal, TelegramSettingTab } from "./src/gui";
import { errMessage } from "./src/util";

export default class SendToTelegramPlugin extends Plugin {
    settings: TelegramSettings;
    secrets: TelegramSecrets = { telegramSession: "", telegramApiId: 0, telegramApiHash: "" };

    private channelCommandIds: string[] = [];
    private forumCache: Map<string, boolean> = new Map();
    private resolvingScheduledLinks = false;

    async onload(): Promise<void> {
        await this.loadSettings();
        this.addSettingTab(new TelegramSettingTab(this.app, this));

        this.registerStaticCommands();

        this.syncChannelCommands();

        // Resolve links for scheduled posts that may have been published while
        // Obsidian was closed (on startup), and periodically while it is open.
        this.app.workspace.onLayoutReady(() => void this.resolvePendingScheduledLinks());
        this.registerInterval(window.setInterval(() => void this.resolvePendingScheduledLinks(), 60_000));

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu: Menu, file: TFile | TFolder) => {
                if (!(file instanceof TFile)) return;
                if (this.settings.channels.length === 0) return;

                menu.addSeparator();

                menu.addItem((item) => {
                    item.setTitle(t.MENU_TITLE).setIcon("paper-plane");
                    item.onClick(async () => {
                        const defaultChannel = await this.resolveDefaultChannel();
                        if (!defaultChannel) {
                            new MultiPresetModal(this.app, this, file).open();
                            return;
                        }
                        void this.sendNoteToTelegram(file, defaultChannel, false, false);
                    });
                });

                menu.addItem((item) => {
                    item.setTitle(t.COMMAND_SEND_MULTIPLE).setIcon("sliders-horizontal");
                    item.onClick(() => {
                        new MultiPresetModal(this.app, this, file).open();
                    });
                });

                menu.addSeparator();
            })
        );
    }

    private registerStaticCommands() {
        this.addCommand({
            id: "send-default",
            name: t.COMMAND_SEND_DEFAULT,
            callback: async () => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return;
                const defaultChannel = await this.resolveDefaultChannel();
                if (!defaultChannel) { new MultiPresetModal(this.app, this, file).open(); return; }
                await this.sendNoteToTelegram(file, defaultChannel, false, false);
            }
        });

        this.addCommand({
            id: "send-multiple",
            name: t.COMMAND_SEND_MULTIPLE,
            callback: () => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return;
                if (this.settings.channels.length === 0) { new Notice(t.NOTICE_ERR_CONFIG); return; }
                new MultiPresetModal(this.app, this, file).open();
            }
        });

        this.addCommand({
            id: "show-formatting-help",
            name: t.COMMAND_SHOW_FORMATTING_HELP,
            callback: () => {
                new FormattingHelpModal(this.app, getUserGuideContent()).open();
            }
        });

        this.addCommand({
            id: "show-changelog",
            name: t.COMMAND_SHOW_CHANGELOG,
            callback: () => {
                new ChangelogModal(this.app, getChangelogContent()).open();
            }
        });
    }

    async resolveDefaultChannel(): Promise<TelegramChannel | undefined> {
        return this.settings.channels.find(c => c.isDefault);
    }

    syncChannelCommands() {
        const commands = (this.app as unknown as { commands: { removeCommand(id: string): void } }).commands;
        this.channelCommandIds.forEach(id => commands.removeCommand(id));
        this.channelCommandIds = [];

        this.settings.channels.forEach(channel => {
            const commandId = `send-channel-${channel.id}`;
            this.addCommand({
                id: commandId,
                name: `${t.COMMAND_SEND_TO_PRESET} ${channel.name || t.CHANNEL_DEFAULT_NAME}`,
                callback: async () => {
                    const file = this.app.workspace.getActiveFile();
                    if (!file) return;
                    // A forum needs a topic to post into. Only prompt (via the advanced modal)
                    // when the preset hasn't already been pointed at specific topic(s); if every
                    // target carries a topicId, the topic is known — post straight to it.
                    const targets = channel.chatTargets ?? [];
                    const hasTopicSelection = targets.length > 0 && targets.every(target => target.topicId !== undefined);
                    const isForum = !hasTopicSelection && await this.isChannelForum(channel);
                    if (isForum) {
                        new MultiPresetModal(this.app, this, file, channel.id).open();
                    } else {
                        await this.sendNoteToTelegram(file, channel, false, false);
                    }
                }
            });
            this.channelCommandIds.push(`${this.manifest.id}:${commandId}`);
        });
    }

    private async isChannelForum(channel: TelegramChannel): Promise<boolean> {
        // Only the account (GramJS) path can detect forums; bot methods set topicId manually.
        if (channel.defaultMethod !== "account") return false;
        if (this.forumCache.has(channel.id)) return this.forumCache.get(channel.id)!;
        const accSecrets = this.getAccountSecrets(channel.accountId);
        if (!accSecrets.telegramSession) return false;
        try {
            const chatId = (channel.chatTargets?.[0]?.id ?? channel.chatId ?? "").trim();
            const entity = /^-?\d+$/.test(chatId) ? parseInt(chatId) : (chatId.startsWith("@") ? chatId : `@${chatId}`);
            const client = await createClient(accSecrets.telegramSession, accSecrets.telegramApiId, accSecrets.telegramApiHash);
            try {
                const result = await checkIsForum(client, entity);
                this.forumCache.set(channel.id, result);
                return result;
            } finally {
                await client.destroy();
            }
        } catch {
            return false;
        }
    }

    async sendNoteToTelegram(file: TFile, channel: TelegramChannel, silent: boolean, attachUnderText: boolean, updateLink?: string, scheduleDate?: Date, method?: PostMethod): Promise<void> {
        // Resolve the effective posting method: explicit override, else the preset default.
        const effectiveMethod = method ?? channel.defaultMethod ?? "account";
        const isBotMethod = effectiveMethod === "bot" || effectiveMethod === "bot-rich";
        const accountPostAsRich = effectiveMethod === "account-rich";
        // Account (GramJS) publishing needs a session; bot methods use the Bot API instead.
        const accountSecrets = isBotMethod ? null : this.getAccountSecrets(channel.accountId);
        if (!isBotMethod && !accountSecrets!.telegramSession) {
            new Notice(t.NOTICE_ERR_NOT_AUTHENTICATED);
            return;
        }

        const targets = channel.chatTargets?.length > 0
            ? channel.chatTargets
            : (channel.chatId ? [{ id: channel.chatId, title: channel.chatTitle, topicId: channel.topicId }] : []);

        if (targets.length === 0) { new Notice(t.NOTICE_ERR_CONFIG); return; }

        const progressNotice = new Notice(updateLink && updateLink !== "none" ? t.NOTICE_EDITING : t.NOTICE_PUBLISHING, 0);
        const allLinks: string[] = [];
        const allCommentLinks: string[] = [];
        const allErrors: Error[] = [];
        const allScheduled: PendingScheduledLink[] = [];

        try {
            if (isBotMethod) {
                // ── Bot API path ──────────────────────────────────────────────
                const { links, commentLinks, errors } = await sendNoteViaBotApi(
                    this.app, file, channel, this.settings,
                    silent, attachUnderText, this.settings.treatMdEmbedsAsComments, updateLink,
                    effectiveMethod === "bot-rich",   // post as Rich Message
                    effectiveMethod === "bot-rich",   // comments follow the post method (rich for "bot + rich")
                );
                allLinks.push(...links);
                allCommentLinks.push(...commentLinks);
                allErrors.push(...errors);
            } else {
                // ── GramJS (User API) path ────────────────────────────────────
                for (const target of targets) {
                    const singleChannel: TelegramChannel = { ...channel, chatId: target.id, chatTitle: target.title, topicId: target.topicId };
                    const { links, commentLinks, errors, scheduled } = await sendNoteToTelegram(
                        this.app, file, singleChannel, this.settings, accountSecrets!, silent, attachUnderText,
                        this.settings.treatMdEmbedsAsComments, updateLink, scheduleDate,
                        () => { progressNotice.setMessage(t.NOTICE_PUBLISHING_COMMENTS); },
                        accountPostAsRich,
                    );
                    allLinks.push(...links);
                    allCommentLinks.push(...commentLinks);
                    allErrors.push(...errors);
                    for (const s of scheduled) {
                        allScheduled.push({ ...s, notePath: file.path, noteTitle: file.basename, accountId: channel.accountId, createdAt: Date.now() });
                    }
                }
            }

            progressNotice.hide();

            // Scheduled posts: persist a task so the published link can be fetched later
            // (the link isn't known until the post actually goes live). Gated on savePostLinks.
            if (this.settings.savePostLinks && allScheduled.length > 0) {
                this.settings.pendingScheduledLinks.push(...allScheduled);
                await this.saveSettings();
            }

            if (this.settings.savePostLinks && (allLinks.length > 0 || allCommentLinks.length > 0) && !scheduleDate) {
                await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
                    if (allLinks.length > 0) {
                        const existing = Array.isArray(fm.tg_posts) ? fm.tg_posts as string[] : [];
                        for (const link of allLinks) {
                            if (!existing.includes(link)) existing.push(link);
                        }
                        fm.tg_posts = existing;
                    }
                    if (allCommentLinks.length > 0) {
                        const existing = Array.isArray(fm.tg_comments) ? fm.tg_comments as string[] : [];
                        for (const link of allCommentLinks) {
                            if (!existing.includes(link)) existing.push(link);
                        }
                        fm.tg_comments = existing;
                    }
                });
            }

            for (const err of allErrors) {
                const msg: string = (err.message ?? "").toUpperCase();
                if (msg.includes("MESSAGE_NOT_MODIFIED")) {
                    new Notice(t.NOTICE_ERR_NOT_MODIFIED);
                } else if (msg.includes("MESSAGE_TOO_LONG") || msg.includes("MESSAGE IS TOO LONG")) {
                    new Notice(t.NOTICE_ERR_TOO_LONG_TEXT);
                } else if (msg.includes("MEDIA_CAPTION_TOO_LONG") || msg.includes("CAPTION IS TOO LONG")) {
                    new Notice(t.NOTICE_ERR_TOO_LONG_CAPTION);
                } else if (msg.includes("RICH_LOCAL_DOC")) {
                    new Notice(t.NOTICE_ERR_RICH_LOCAL_DOC);
                } else if (msg.includes("RICH_LOCAL_MEDIA")) {
                    new Notice(t.NOTICE_ERR_RICH_LOCAL_MEDIA);
                } else if (msg.includes("MIXED_MEDIA_CLASSIC")) {
                    new Notice(t.NOTICE_ERR_MIXED_MEDIA);
                } else if (msg.includes("PREMIUM")) {
                    new Notice(t.NOTICE_ERR_ACCOUNT_RICH_PREMIUM);
                } else {
                    new Notice(`${t.NOTICE_ERR_SEND}${err.message ?? ""}`);
                }
            }

            if (allErrors.length === 0) new Notice(scheduleDate ? t.NOTICE_SCHEDULED : (updateLink && updateLink !== "none" ? t.NOTICE_EDITED : t.NOTICE_SUCCESS));

        } catch (err) {
            progressNotice.hide();
            const msg: string = errMessage(err).toUpperCase();
            if (msg.includes("MESSAGE_NOT_MODIFIED")) {
                new Notice(t.NOTICE_ERR_NOT_MODIFIED);
            } else if (msg.includes("MESSAGE_TOO_LONG") || msg.includes("MESSAGE IS TOO LONG")) {
                new Notice(t.NOTICE_ERR_TOO_LONG_TEXT);
            } else if (msg.includes("MEDIA_CAPTION_TOO_LONG") || msg.includes("CAPTION IS TOO LONG")) {
                new Notice(t.NOTICE_ERR_TOO_LONG_CAPTION);
            } else if (msg.includes("RICH_LOCAL_DOC")) {
                new Notice(t.NOTICE_ERR_RICH_LOCAL_DOC);
            } else if (msg.includes("RICH_LOCAL_MEDIA")) {
                new Notice(t.NOTICE_ERR_RICH_LOCAL_MEDIA);
            } else if (msg.includes("MIXED_MEDIA_CLASSIC")) {
                new Notice(t.NOTICE_ERR_MIXED_MEDIA);
            } else {
                new Notice(`${t.NOTICE_ERR_SEND}${errMessage(err)}`);
            }
        }
    }

    // Checks pending scheduled posts whose send time has passed: writes the published
    // link into the note's tg_posts when found, drops the task (notifying) when the
    // scheduled message was cancelled/deleted, and keeps tasks that haven't sent yet.
    async resolvePendingScheduledLinks(): Promise<void> {
        if (this.resolvingScheduledLinks) return;
        if (this.settings.accounts.length === 0) return;
        if (this.settings.pendingScheduledLinks.length === 0) return;

        const nowSec = Math.floor(Date.now() / 1000);
        const due = this.settings.pendingScheduledLinks.filter(task => task.scheduledDate <= nowSec);
        if (due.length === 0) return;

        this.resolvingScheduledLinks = true;
        try {
            // Resolve each task with the account that scheduled it (grouped to reuse one
            // client per account); tasks without an accountId fall back to the primary.
            const byAccount = new Map<string, PendingScheduledLink[]>();
            for (const task of due) {
                const key = this.settings.accounts.some(a => a.id === task.accountId)
                    ? task.accountId! : (this.settings.accounts[0]?.id ?? "");
                const group = byAccount.get(key) ?? [];
                group.push(task);
                byAccount.set(key, group);
            }
            const resolutions = (await Promise.all(
                [...byAccount.entries()].map(([accountId, tasks]) =>
                    resolveScheduledLinks(this.getAccountSecrets(accountId), tasks))
            )).flat();
            const settled = new Set<PendingScheduledLink>();

            for (const { task, status, link, updatedScheduledDate } of resolutions) {
                if (status === "pending") {
                    // Sync the stored send time if the message was rescheduled in Telegram.
                    // This prevents the task being "always due" after its original date passes.
                    if (updatedScheduledDate !== undefined) {
                        task.scheduledDate = updatedScheduledDate;
                    }
                    continue;
                }

                if (status === "resolved" && link) {
                    const noteFile = this.app.vault.getAbstractFileByPath(task.notePath);
                    if (noteFile instanceof TFile) {
                        await this.app.fileManager.processFrontMatter(noteFile, (fm: Record<string, unknown>) => {
                            const existing = Array.isArray(fm.tg_posts) ? fm.tg_posts as string[] : [];
                            if (!existing.includes(link)) existing.push(link);
                            fm.tg_posts = existing;
                        });
                        new Notice(t.NOTICE_SCHEDULED_LINK_SAVED.replace("{title}", task.noteTitle));
                    }
                    // Note was deleted/renamed away — drop the task silently.
                } else if (status === "unresolved") {
                    new Notice(t.NOTICE_SCHEDULED_LINK_FAILED.replace("{title}", task.noteTitle));
                }
                settled.add(task);
            }

            const anyUpdated = resolutions.some(r => r.status === "pending" && r.updatedScheduledDate !== undefined);
            if (settled.size > 0 || anyUpdated) {
                this.settings.pendingScheduledLinks = this.settings.pendingScheduledLinks.filter(task => !settled.has(task));
                await this.saveSettings();
            }
        } catch (err) {
            // Connection/network failure — leave tasks in place to retry next tick.
            console.error("Failed to resolve scheduled post links:", errMessage(err));
        } finally {
            this.resolvingScheduledLinks = false;
        }
    }

    async editNoteComments(file: TFile, commentLinks: string[], silent: boolean, method: PostMethod = "account", botToken?: string, embedOffset = 0): Promise<void> {
        // Comment editing follows the method of the preset chosen for the edit: account
        // comments are edited via the account, bot / bot-rich comments via the bot that
        // owns them (preserving rich formatting for "bot + rich").
        const isBot = method === "bot" || method === "bot-rich";
        if (isBot) {
            if (!botToken) { new Notice(t.NOTICE_ERR_CONFIG); return; }
        } else if (this.settings.accounts.length === 0) {
            new Notice(t.NOTICE_ERR_NOT_AUTHENTICATED); return;
        }
        const progressNotice = new Notice(t.NOTICE_EDITING_COMMENTS, 0);
        try {
            let errors: Error[];
            if (isBot) {
                const comments = commentLinks.map(link => {
                    const parsed = parseLinkComponents(link);
                    return parsed ? { chatId: parsed.chatId, messageId: parsed.messageId } : null;
                });
                ({ errors } = await editNoteCommentsViaBotApi(this.app, file, botToken!, comments, method === "bot-rich", embedOffset));
            } else {
                ({ errors } = await editNoteCommentsOnly(this.app, file, this.secrets, commentLinks, silent, embedOffset, method === "account-rich"));
            }
            progressNotice.hide();
            for (const err of errors) {
                const msg = (err.message ?? "").toUpperCase();
                if (msg.includes("MESSAGE_NOT_MODIFIED")) new Notice(t.NOTICE_ERR_NOT_MODIFIED);
                else new Notice(`${t.NOTICE_ERR_SEND}${err.message ?? ""}`);
            }
            if (errors.length === 0) new Notice(t.NOTICE_COMMENTS_EDITED);
        } catch (err) {
            progressNotice.hide();
            new Notice(`${t.NOTICE_ERR_SEND}${errMessage(err)}`);
        }
    }

    async loadSettings() {
        const raw = (await this.loadData() ?? {}) as Partial<TelegramSettings> & {
            telegramSession?: string;
            telegramApiId?: number;
            telegramApiHash?: string;
        };
        this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
        // Migrate single chatId/chatTitle → chatTargets array; legacy bot/user type → defaultMethod
        let migrated = false;
        for (const ch of this.settings.channels) {
            const legacy = ch as TelegramChannel & { type?: "bot" | "user" };
            if (!ch.chatTargets) {
                ch.chatTargets = ch.chatId ? [{ id: ch.chatId, title: ch.chatTitle }] : [];
                migrated = true;
            }
            if (!ch.defaultMethod) {
                ch.defaultMethod = legacy.type === "bot" ? "bot" : "account";
                migrated = true;
            }
            if (legacy.type !== undefined) {
                delete legacy.type;
                migrated = true;
            }
        }
        if (migrated) await this.saveData(this.settings);
        // Named bot tokens supersede per-preset tokens. Clear any legacy per-preset
        // token (stored either in data.json or under `bot-token-${ch.id}`) — presets
        // now reference a shared BotToken via botTokenId. Start fresh, no migration.
        let botTokenCleared = false;
        for (const ch of this.settings.channels) {
            if (ch.botToken) {
                delete ch.botToken;
                botTokenCleared = true;
            }
            if (!ch.botTokenId) {
                this.app.secretStorage.setSecret(`bot-token-${ch.id}`, "");
            }
        }
        if (botTokenCleared) await this.saveData(this.settings);
        // Migrate secrets from data.json to SecretStorage — reuse raw, no second loadData()
        if (raw?.telegramSession) {
            this.app.secretStorage.setSecret("telegram-session", raw.telegramSession);
            this.app.secretStorage.setSecret("telegram-api-id", String(raw.telegramApiId || 0));
            this.app.secretStorage.setSecret("telegram-api-hash", raw.telegramApiHash || "");
            delete raw.telegramSession;
            delete raw.telegramApiId;
            delete raw.telegramApiHash;
            await this.saveData(raw);
        }
        // Migrate the single legacy session → accounts[]. The old session lived under
        // `telegram-session`; move it into one account and point existing user presets at it.
        if (this.settings.accounts.length === 0) {
            const legacySession = this.app.secretStorage.getSecret("telegram-session");
            if (legacySession) {
                const id = Date.now().toString();
                this.settings.accounts.push({
                    id,
                    displayName: this.settings.telegramDisplayName || "",
                    apiId: Number(this.app.secretStorage.getSecret("telegram-api-id") ?? 0),
                    apiHash: this.app.secretStorage.getSecret("telegram-api-hash") ?? "",
                });
                this.app.secretStorage.setSecret(`account-session-${id}`, legacySession);
                this.app.secretStorage.setSecret("telegram-session", "");
                this.app.secretStorage.setSecret("telegram-api-id", "0");
                this.app.secretStorage.setSecret("telegram-api-hash", "");
                for (const ch of this.settings.channels) {
                    if (ch.defaultMethod === "account" && !ch.accountId) ch.accountId = id;
                }
                await this.saveData(this.settings);
            }
        }
        await this.loadSecrets();
    }

    async loadSecrets() {
        // `this.secrets` mirrors the primary (first) account for auxiliary flows that
        // aren't tied to a specific preset (comment editing). Per-preset publishing
        // resolves its own account via getAccountSecrets(channel.accountId).
        this.secrets = this.getAccountSecrets();
        for (const ch of this.settings.channels) {
            ch.botToken = ch.botTokenId
                ? (this.app.secretStorage.getSecret(`bot-token-${ch.botTokenId}`) ?? "")
                : "";
        }
    }

    // Resolves the GramJS credentials for the given account (defaults to the primary
    // account when no/unknown id). Returns empty secrets when no account exists.
    getAccountSecrets(accountId?: string): TelegramSecrets {
        const acc = this.settings.accounts.find(a => a.id === accountId) ?? this.settings.accounts[0];
        if (!acc) return { telegramSession: "", telegramApiId: 0, telegramApiHash: "" };
        return {
            telegramSession: this.app.secretStorage.getSecret(`account-session-${acc.id}`) ?? "",
            telegramApiId: acc.apiId,
            telegramApiHash: acc.apiHash,
        };
    }

    addAccount(account: TelegramAccount, session: string): void {
        this.app.secretStorage.setSecret(`account-session-${account.id}`, session);
        this.settings.accounts.push(account);
        this.secrets = this.getAccountSecrets();
    }

    // Re-login into an already-connected account: the old session is overwritten by the
    // new one and the account keeps its id, so presets referencing it stay wired up.
    replaceAccount(accountId: string, fields: Omit<TelegramAccount, "id">, session: string): void {
        const idx = this.settings.accounts.findIndex(a => a.id === accountId);
        if (idx === -1) return;
        this.app.secretStorage.setSecret(`account-session-${accountId}`, session);
        this.settings.accounts[idx] = { id: accountId, ...fields };
        this.secrets = this.getAccountSecrets();
    }

    removeAccount(accountId: string): void {
        this.app.secretStorage.setSecret(`account-session-${accountId}`, "");
        this.settings.accounts = this.settings.accounts.filter(a => a.id !== accountId);
        for (const ch of this.settings.channels) {
            if (ch.accountId === accountId) ch.accountId = undefined;
        }
        this.secrets = this.getAccountSecrets();
    }

    saveBotToken(tokenId: string, token: string): void {
        this.app.secretStorage.setSecret(`bot-token-${tokenId}`, token);
    }

    deleteBotToken(tokenId: string): void {
        this.app.secretStorage.setSecret(`bot-token-${tokenId}`, "");
    }

    getBotTokenValue(tokenId: string): string {
        return this.app.secretStorage.getSecret(`bot-token-${tokenId}`) ?? "";
    }

    async saveSettings() {
        const stripped = {
            ...this.settings,
            channels: this.settings.channels.map(({ botToken: _t, ...ch }) => ch),
        };
        await this.saveData(stripped);
        this.syncChannelCommands();
    }
}
