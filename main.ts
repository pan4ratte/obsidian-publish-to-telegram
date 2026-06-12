import { Plugin, Notice, TFile, TFolder, Menu } from "obsidian";
import { t, getUserGuideContent, changelogContent } from "./lang/helpers";
import { TelegramChannel, TelegramSettings, TelegramSecrets, DEFAULT_SETTINGS, PendingScheduledLink } from "./src/types";
import { sendNoteToTelegram, editNoteCommentsOnly, checkIsForum, createClient, resolveScheduledLinks } from "./src/telegram";
import { sendNoteViaBotApi } from "./src/telegram-bot";
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
                new ChangelogModal(this.app, changelogContent).open();
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
                    const isForum = await this.isChannelForum(channel);
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
        if (channel.type === "bot") return false; // Bot API: user configures topicId directly in chat picker
        if (this.forumCache.has(channel.id)) return this.forumCache.get(channel.id)!;
        if (!this.secrets.telegramSession) return false;
        try {
            const chatId = (channel.chatTargets?.[0]?.id ?? channel.chatId ?? "").trim();
            const entity = /^-?\d+$/.test(chatId) ? parseInt(chatId) : (chatId.startsWith("@") ? chatId : `@${chatId}`);
            const client = await createClient(this.secrets.telegramSession, this.secrets.telegramApiId, this.secrets.telegramApiHash);
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

    async sendNoteToTelegram(file: TFile, channel: TelegramChannel, silent: boolean, attachUnderText: boolean, updateLink?: string, scheduleDate?: Date, commentsAsRich = false): Promise<void> {
        // Bot presets use their own send path and don't need a GramJS session.
        if (channel.type !== "bot" && !this.secrets.telegramSession) {
            new Notice(t.NOTICE_ERR_NOT_AUTHENTICATED);
            return;
        }

        const targets = channel.chatTargets?.length > 0
            ? channel.chatTargets
            : (channel.chatId ? [{ id: channel.chatId, title: channel.chatTitle }] : []);

        if (targets.length === 0) { new Notice(t.NOTICE_ERR_CONFIG); return; }

        const progressNotice = new Notice(updateLink && updateLink !== "none" ? t.NOTICE_EDITING : t.NOTICE_PUBLISHING, 0);
        const allLinks: string[] = [];
        const allCommentLinks: string[] = [];
        const allErrors: Error[] = [];
        const allScheduled: PendingScheduledLink[] = [];

        try {
            if (channel.type === "bot") {
                // ── Bot API path ──────────────────────────────────────────────
                const { links, errors } = await sendNoteViaBotApi(
                    this.app, file, channel, this.settings,
                    silent, attachUnderText, this.settings.treatMdEmbedsAsComments, updateLink, commentsAsRich,
                );
                allLinks.push(...links);
                allErrors.push(...errors);
            } else {
                // ── GramJS (User API) path ────────────────────────────────────
                for (const target of targets) {
                    const singleChannel: TelegramChannel = { ...channel, chatId: target.id, chatTitle: target.title };
                    const { links, commentLinks, errors, scheduled } = await sendNoteToTelegram(
                        this.app, file, singleChannel, this.settings, this.secrets, silent, attachUnderText,
                        this.settings.treatMdEmbedsAsComments, updateLink, scheduleDate,
                        () => { progressNotice.setMessage(t.NOTICE_PUBLISHING_COMMENTS); }
                    );
                    allLinks.push(...links);
                    allCommentLinks.push(...commentLinks);
                    allErrors.push(...errors);
                    for (const s of scheduled) {
                        allScheduled.push({ ...s, notePath: file.path, noteTitle: file.basename, createdAt: Date.now() });
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
        if (!this.secrets.telegramSession) return;
        if (this.settings.pendingScheduledLinks.length === 0) return;

        const nowSec = Math.floor(Date.now() / 1000);
        const due = this.settings.pendingScheduledLinks.filter(task => task.scheduledDate <= nowSec);
        if (due.length === 0) return;

        this.resolvingScheduledLinks = true;
        try {
            const resolutions = await resolveScheduledLinks(this.secrets, due);
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

    async editNoteComments(file: TFile, commentLinks: string[], silent: boolean, embedOffset = 0): Promise<void> {
        if (!this.secrets.telegramSession) { new Notice(t.NOTICE_ERR_NOT_AUTHENTICATED); return; }
        const progressNotice = new Notice(t.NOTICE_EDITING_COMMENTS, 0);
        try {
            const { errors } = await editNoteCommentsOnly(this.app, file, this.secrets, commentLinks, silent, embedOffset);
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
        // Migrate single chatId/chatTitle → chatTargets array; default type to "user"
        let migrated = false;
        for (const ch of this.settings.channels) {
            if (!ch.chatTargets) {
                ch.chatTargets = ch.chatId ? [{ id: ch.chatId, title: ch.chatTitle }] : [];
                migrated = true;
            }
            if (!ch.type) {
                ch.type = "user";
                migrated = true;
            }
        }
        if (migrated) await this.saveData(this.settings);
        // Migrate bot tokens from data.json to SecretStorage
        let botTokenMigrated = false;
        for (const ch of this.settings.channels) {
            if (ch.botToken) {
                this.app.secretStorage.setSecret(`bot-token-${ch.id}`, ch.botToken);
                delete ch.botToken;
                botTokenMigrated = true;
            }
        }
        if (botTokenMigrated) await this.saveData(this.settings);
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
        await this.loadSecrets();
    }

    async loadSecrets() {
        const session = this.app.secretStorage.getSecret("telegram-session");
        const apiId = this.app.secretStorage.getSecret("telegram-api-id");
        const apiHash = this.app.secretStorage.getSecret("telegram-api-hash");
        this.secrets = {
            telegramSession: session ?? "",
            telegramApiId: Number(apiId ?? 0),
            telegramApiHash: apiHash ?? "",
        };
        for (const ch of this.settings.channels) {
            if (ch.type === "bot") {
                ch.botToken = this.app.secretStorage.getSecret(`bot-token-${ch.id}`) ?? "";
            }
        }
    }

    async saveSecrets() {
        this.app.secretStorage.setSecret("telegram-session", this.secrets.telegramSession);
        this.app.secretStorage.setSecret("telegram-api-id", String(this.secrets.telegramApiId));
        this.app.secretStorage.setSecret("telegram-api-hash", this.secrets.telegramApiHash);
    }

    async clearSecrets() {
        this.secrets = { telegramSession: "", telegramApiId: 0, telegramApiHash: "" };
        this.app.secretStorage.setSecret("telegram-session", "");
        this.app.secretStorage.setSecret("telegram-api-id", "0");
        this.app.secretStorage.setSecret("telegram-api-hash", "");
    }

    saveBotToken(channelId: string, token: string): void {
        this.app.secretStorage.setSecret(`bot-token-${channelId}`, token);
    }

    deleteBotToken(channelId: string): void {
        this.app.secretStorage.setSecret(`bot-token-${channelId}`, "");
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
