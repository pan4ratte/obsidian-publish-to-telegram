import { Plugin, Notice, TFile, TFolder, Menu } from "obsidian";
import { t } from "./lang/helpers";
import { TelegramChannel, TelegramSettings, DEFAULT_SETTINGS } from "./src/types";
import { sendNoteToTelegram } from "./src/telegram";
import { FormattingHelpModal, MultiPresetModal, TelegramSettingTab } from "./src/gui";

export default class SendToTelegramPlugin extends Plugin {
    settings: TelegramSettings;
    private tokenCache: Map<string, string> = new Map();
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

    // UPDATED: Added updateLink parameter
    async sendNoteToTelegram(file: TFile, channel: TelegramChannel, silent: boolean, attachUnderText: boolean, updateLink?: string): Promise<void> {
        try {
            // Get the bot token from our cache (or from channel.botToken as fallback)
            const botToken = this.tokenCache.get(channel.id) ?? channel.botToken ?? '';
            if (!botToken) {
                throw new Error('Bot token not found for channel ' + channel.id);
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
        await this.migrateTokensToSecretStorage();
    }

    private async migrateTokensToSecretStorage() {
        // Optional chaining for older Obsidian versions lacking getSecretStorage
        const secretStorage = this.app.vault.getSecretStorage?.();
        if (!secretStorage) {
            // SecretStorage not available, keep botToken in settings (fallback)
            // Ensure every channel has botToken as string (optional, but we'll set to empty if undefined)
            for (const channel of this.settings.channels) {
                if (channel.botToken === undefined) {
                    channel.botToken = '';
                }
            }
            return;
        }
        for (const channel of this.settings.channels) {
            const key = `telegram-bot-token:${channel.id}`;
            if (channel.botToken && channel.botToken.trim() !== '') {
                // Migrate existing token from settings to SecretStorage
                const existing = await secretStorage.get(key);
                if (!existing) {
                    await secretStorage.set(key, channel.botToken);
                }
                this.tokenCache.set(channel.id, channel.botToken);
                // Keep botToken in channel for UI; will be stripped before saving
            } else {
                // Try to load token from SecretStorage
                const stored = await secretStorage.get(key);
                if (stored) {
                    this.tokenCache.set(channel.id, stored);
                    channel.botToken = stored; // populate UI
                } else {
                    // No token found anywhere, ensure it's an empty string for UI
                    channel.botToken = '';
                }
            }
        }
    }

    async saveSettings() {
        // Create a copy of settings without botToken to avoid persisting it
        const channelsForSave = this.settings.channels.map(c => ({
            id: c.id,
            name: c.name,
            chatId: c.chatId,
            isDefault: c.isDefault
        }));
        const dataToSave = {
            ...this.settings,
            channels: channelsForSave
        };
        await this.saveData(dataToSave);
        this.syncChannelCommands();
    }
}
