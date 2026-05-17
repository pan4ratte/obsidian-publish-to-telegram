import { Plugin, Notice, TFile, TFolder, Menu } from "obsidian";
import { t } from "./lang/helpers";
import { TelegramChannel, TelegramSettings, DEFAULT_SETTINGS } from "./src/types";
import { extractFrontmatter, prepareContent, sendNoteToTelegram } from "./src/telegram";
import { FormattingHelpModal, LimitsWarningModal, MultiPresetModal, TelegramSettingTab } from "./src/gui";

export default class SendToTelegramPlugin extends Plugin {
    settings: TelegramSettings;
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

    // If no preset is set as default but only one exists, that preset is set as default
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

            // ── Limits check ────────────────────────────────────────────────
            const content = await this.app.vault.read(file);
            const { body } = extractFrontmatter(content);
            let textToProcess = body;
            const startMarker = channel.postStartMarker || this.settings.postStartMarker;
            const endMarker = channel.postEndMarker || this.settings.postEndMarker;
            if (startMarker && endMarker) {
                const startIdx = body.indexOf(startMarker);
                const endIdx = body.indexOf(endMarker, startIdx !== -1 ? startIdx + startMarker.length : 0);
                if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
                    textToProcess = body.slice(startIdx + startMarker.length, endIdx);
                } else if (startIdx !== -1 && endIdx === -1) {
                    textToProcess = body.slice(startIdx + startMarker.length);
                } else if (startIdx === -1 && endIdx !== -1) {
                    textToProcess = body.slice(0, endIdx);
                }
            }
            const formattedContent = prepareContent(textToProcess);
            if (formattedContent.length > 4096) {
                const proceed = await new Promise<boolean>(resolve => {
                    new LimitsWarningModal(this.app, formattedContent.length,
                        () => resolve(true),
                        () => resolve(false)
                    ).open();
                });
                if (!proceed) return;
            }

            // UPDATED: Pass updateLink and markers through to the core function
            const link = await sendNoteToTelegram(
                this.app,
                file,
                channel,
                silent,
                attachUnderText,
                this.settings.treatMdEmbedsAsComments,
                updateLink,
                this.settings.postStartMarker,
                this.settings.postEndMarker,
                botToken
            );

            if (this.settings.savePostLinks && link) {
                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    if (!Array.isArray(fm.telegram_links)) fm.telegram_links = [];
                    // UPDATED: Only push the link if it doesn't already exist (prevents duplicates when updating)
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
        } catch {}

        // Fallback: migrate old per-channel token or read from data.json
        for (const ch of loaded.channels || []) {
            if (ch.botToken && ch.botToken.trim() !== '') {
                try {
                    const ss: any = (this.app as any)?.secretStorage;
                    if (ss && typeof ss.setSecret === "function") {
                        ss.setSecret("publish-to-tg-bot-token", ch.botToken);
                    }
                } catch {}
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
        } catch {}
        this.botToken = token;
        new Notice(t.NOTICE_TOKEN_SAVED, 3000);
    }

    removeBotToken(): void {
        try {
            const ss: any = (this.app as any)?.secretStorage;
            if (ss && typeof ss.setSecret === "function") {
                ss.setSecret("publish-to-tg-bot-token", "");
            }
        } catch {}
        this.botToken = '';
        new Notice(t.NOTICE_TOKEN_DELETED, 3000);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.syncChannelCommands();
    }
}
