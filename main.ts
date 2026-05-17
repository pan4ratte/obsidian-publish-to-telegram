import { Plugin, Notice, TFile, TFolder, Menu } from "obsidian";
import { t } from "./lang/helpers";
import { TelegramChannel, TelegramSettings, DEFAULT_SETTINGS } from "./src/types";
import { CHAR_LIMIT, prepareNoteContent, sendNoteToTelegram } from "./src/telegram";
import { FormattingHelpModal, LimitsWarningModal, MultiPresetModal, TelegramSettingTab } from "./src/gui";

export default class SendToTelegramPlugin extends Plugin {
    settings!: TelegramSettings;
    private botToken: string = '';
    private channelCommandIds: string[] = [];

    async onload(): Promise<void> {
        await this.loadSettings();
        this.addSettingTab(new TelegramSettingTab(this.app, this));

        this.registerStaticCommands();

        this.syncChannelCommands();

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu: Menu, file: TFile | TFolder) => {
                if (!(file instanceof TFile)) return;
                if (this.settings.channels.length === 0) return;

                menu.addItem((item) => {
                    item.setTitle(t.MENU_TITLE).setIcon("paper-plane");
                    item.onClick(async () => {
                        const defaultChannel = await this.resolveDefaultChannel();
                        if (!defaultChannel) {
                            new Notice(t.NOTICE_ERR_NO_DEFAULT);
                            return;
                        }
                        this.sendNoteToTelegram(file, defaultChannel, false, false);
                    });
                });
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
                if (!defaultChannel) { new Notice(t.NOTICE_ERR_NO_DEFAULT); return; }
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
                new FormattingHelpModal(this.app, this).open();
            }
        });
    }

    async resolveDefaultChannel(): Promise<TelegramChannel | undefined> {
        const explicit = this.settings.channels.find(c => c.isDefault);
        if (explicit) return explicit;

        if (this.settings.channels.length === 1) {
            this.settings.channels[0].isDefault = true;
            await this.saveSettings();
            return this.settings.channels[0];
        }

        return undefined;
    }

    syncChannelCommands() {
        const commands = (this.app as any).commands;
        this.channelCommandIds.forEach(id => commands.removeCommand(id));
        this.channelCommandIds = [];

        this.settings.channels.forEach(channel => {
            const commandId = `send-channel-${channel.id}`;
            this.addCommand({
                id: commandId,
                name: `${t.COMMAND_SEND_TO_PRESET} ${channel.name || t.UNTITLED_CHANNEL}`,
                callback: async () => {
                    const file = this.app.workspace.getActiveFile();
                    if (!file) return;
                    await this.sendNoteToTelegram(file, channel, false, false);
                }
            });
            this.channelCommandIds.push(`${this.manifest.id}:${commandId}`);
        });
    }

    async sendNoteToTelegram(file: TFile, channel: TelegramChannel, silent: boolean, attachUnderText: boolean, updateLink?: string): Promise<void> {
        const botToken = this.getBotToken();
        if (!botToken) {
            new Notice(t.NOTICE_ERR_NO_TOKEN);
            return;
        }

        try {
            const startMarker = channel.postStartMarker || this.settings.postStartMarker;
            const endMarker = channel.postEndMarker || this.settings.postEndMarker;

            const formattedContent = await prepareNoteContent(this.app, file, startMarker, endMarker);

            if (formattedContent.length > CHAR_LIMIT) {
                const proceed = await new Promise<boolean>(resolve => {
                    new LimitsWarningModal(this.app, formattedContent.length,
                        () => resolve(true), () => resolve(false)
                    ).open();
                });
                if (!proceed) return;
            }

            const link = await sendNoteToTelegram(
                this.app, file, channel, silent, attachUnderText,
                this.settings.treatMdEmbedsAsComments, updateLink,
                this.settings.postStartMarker, this.settings.postEndMarker,
                botToken, formattedContent,
            );

            if (this.settings.savePostLinks && link) {
                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    if (!Array.isArray(fm.telegram_links)) fm.telegram_links = [];
                    if (!fm.telegram_links.includes(link)) {
                        fm.telegram_links.push(link);
                    }
                });
            }
            new Notice(t.NOTICE_SUCCESS);
        } catch (err: any) {
            new Notice(`${t.NOTICE_ERR_SEND}${err.message}`);
        }
    }

    async loadSettings() {
        const loaded = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

        try {
            const ss: any = (this.app as any)?.secretStorage;
            if (ss && typeof ss.getSecret === "function") {
                const stored = ss.getSecret("publish-to-tg-bot-token");
                if (stored) {
                    this.botToken = stored;
                    return;
                }
            }
        } catch (e: any) {
            console.error("SecretStorage get failed:", e);
        }

        for (const ch of loaded.channels || []) {
            if (ch.botToken && ch.botToken.trim() !== '') {
                try {
                    const ss: any = (this.app as any)?.secretStorage;
                    if (ss && typeof ss.setSecret === "function") {
                        ss.setSecret("publish-to-tg-bot-token", ch.botToken);
                    }
                } catch (e: any) {
                    console.error("SecretStorage migration failed:", e);
                }
                this.botToken = ch.botToken;
                break;
            }
        }
    }

    getBotToken(): string {
        return this.botToken;
    }

    hasBotToken(): boolean {
        return this.botToken !== '';
    }

    saveBotToken(token: string): void {
        if (!token.trim()) return;
        try {
            const ss: any = (this.app as any)?.secretStorage;
            if (ss && typeof ss.setSecret === "function") {
                ss.setSecret("publish-to-tg-bot-token", token);
            }
        } catch (e: any) {
            console.error("SecretStorage set failed:", e);
        }
        this.botToken = token;
        new Notice(t.NOTICE_TOKEN_SAVED, 3000);
    }

    removeBotToken(): void {
        try {
            const ss: any = (this.app as any)?.secretStorage;
            if (ss && typeof ss.setSecret === "function") {
                ss.setSecret("publish-to-tg-bot-token", "");
            }
        } catch (e: any) {
            console.error("SecretStorage remove failed:", e);
        }
        this.botToken = '';
        new Notice(t.NOTICE_TOKEN_DELETED, 3000);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.syncChannelCommands();
    }
}
