import { Plugin, Notice, TFile, TFolder, Menu, Editor } from "obsidian";
import { t, getUserGuideContent, getChangelogContent } from "./lang/helpers";
import { TelegramChannel, TelegramSettings, TelegramSecrets, TelegramAccount, PostMethod, DEFAULT_SETTINGS, PendingScheduledLink } from "./src/types";
import { sendNoteToTelegram, editNoteCommentsOnly, checkIsForum, createClient, resolveScheduledLinks, parseLinkComponents } from "./src/telegram";
import { sendNoteViaBotApi, editNoteCommentsViaBotApi } from "./src/telegram-bot";
import { writeLinksIntoMarkers } from "./src/split";
import { ChangelogModal, FormattingHelpModal, MultiPresetModal, TelegramSettingTab } from "./src/gui";
import { errMessage } from "./src/util";

// Rich-text formatting snippets offered in the editor context menu. Each entry wraps the
// current selection (or, with nothing selected, a placeholder that gets selected after
// insertion) as `before` + selection + `after`. These mirror the rich-text tags documented
// in the README's "Rich-text formatting" section.
// Dedicated section id grouping the plugin's editor-menu items together, separated by a divider.
const MENU_SECTION = "publish-to-telegram";

interface FormattingOption { title: string; icon: string; before: string; inner: string; after: string; }

const richFormattingOptions = (): FormattingOption[] => [
    { title: t.MENU_FMT_ACCORDION, icon: "chevrons-down-up", before: "<details>\n<summary>Title</summary>\n\n", inner: "Content", after: "\n</details>\n" },
    { title: t.MENU_FMT_CENTERED_QUOTE, icon: "quote", before: "<aside>", inner: "Quote", after: "</aside>" },
    { title: t.MENU_FMT_CENTERED_QUOTE_AUTHOR, icon: "users", before: "<aside>", inner: "Quote", after: "<cite>Author</cite></aside>" },
    { title: t.MENU_FMT_EMAIL_LINK, icon: "send", before: '<a href="mailto:email@example.com">', inner: "Text", after: "</a>" },
    { title: t.MENU_FMT_REFERENCE_LINK, icon: "link", before: '<a href="#reference-name">', inner: "Text", after: "</a>" },
    { title: t.MENU_FMT_REFERENCE_TEXT, icon: "bookmark", before: '<tg-reference name="reference-name">', inner: "Text", after: "</tg-reference>" },
    { title: t.MENU_FMT_FOOTER, icon: "separator-horizontal", before: "<footer>", inner: "Footer text", after: "</footer>" },
    { title: t.MENU_FMT_MATH, icon: "sigma", before: "<tg-math-block>", inner: "E = mc^2", after: "</tg-math-block>" },
    { title: t.MENU_FMT_CAPTIONED_MEDIA, icon: "image", before: '<figure>\n<img src="https://example.com/photo.jpg">\n<figcaption>', inner: "Caption", after: "</figcaption>\n</figure>\n" },
    { title: t.MENU_FMT_MAP, icon: "navigation", before: '<tg-map lat="', inner: "0.0", after: '" long="0.0" zoom="15"/>' },
    { title: t.MENU_FMT_COLLAGE, icon: "layout-grid", before: '<tg-collage>\n<img src="', inner: "https://example.com/1.jpg", after: '">\n<img src="https://example.com/2.jpg">\n</tg-collage>\n' },
    { title: t.MENU_FMT_SLIDESHOW, icon: "gallery-vertical", before: '<tg-slideshow>\n<img src="', inner: "https://example.com/1.jpg", after: '">\n<img src="https://example.com/2.jpg">\n</tg-slideshow>\n' },
];

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

        this.registerEditorMenu();
    }

    // Adds the in-note context-menu group: a "Insert post split marker" command and a
    // "Rich-text formatting" submenu that inserts the rich-text tags documented in the README.
    // Both items live in their own section rendered directly below Obsidian's formatting section.
    private registerEditorMenu() {
        this.registerEvent(
            this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
                this.placeSectionBelowFormatting(menu, MENU_SECTION);

                menu.addItem((item) => {
                    item.setTitle(t.MENU_INSERT_SPLIT).setIcon("scissors").setSection(MENU_SECTION);
                    item.onClick(() => this.insertSplitMarker(editor));
                });

                menu.addItem((item) => {
                    item.setTitle(t.MENU_RICH_FORMATTING).setIcon("type").setSection(MENU_SECTION);
                    // setSubmenu() exists at runtime (Obsidian ≥ 1.4) but isn't in the public typings.
                    const submenu = (item as unknown as { setSubmenu(): Menu }).setSubmenu();
                    for (const opt of richFormattingOptions()) {
                        submenu.addItem((sub) => {
                            sub.setTitle(opt.title).setIcon(opt.icon);
                            sub.onClick(() => this.insertFormatting(editor, opt.before, opt.inner, opt.after));
                        });
                    }
                });
            })
        );
    }

    // Slots our section into the menu's ordered section list directly below Obsidian's formatting
    // group. In the editor menu, formatting spans the "selection-link" / "selection" / "insert"
    // sections, immediately followed by "clipboard" (cut/copy/paste) — so inserting right before
    // "clipboard" lands our group directly beneath the whole formatting group (with a divider).
    // `menu.sections` is the runtime order array driving section layout; it isn't in the public
    // typings, so guard defensively and fall back sensibly when the expected sections are absent.
    private placeSectionBelowFormatting(menu: Menu, section: string): void {
        const sections = (menu as unknown as { sections?: string[] }).sections;
        if (!Array.isArray(sections) || sections.includes(section)) return;
        const clipboard = sections.indexOf("clipboard");
        if (clipboard >= 0) { sections.splice(clipboard, 0, section); return; }
        // No clipboard section (e.g. nothing selected): fall in just after the last formatting section.
        const formatting = ["insert", "selection", "selection-link"].map(s => sections.indexOf(s)).filter(i => i >= 0);
        if (formatting.length > 0) sections.splice(Math.max(...formatting) + 1, 0, section);
        else sections.push(section);
    }

    // Inserts `%% \split %%` on its own line at the cursor, adding blank lines as needed so the
    // marker never shares a line with other text (the split parser only matches whole-line markers).
    private insertSplitMarker(editor: Editor): void {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const before = line.slice(0, cursor.ch).trim().length > 0 ? "\n\n" : "";
        const after = line.slice(cursor.ch).trim().length > 0 ? "\n\n" : "\n";
        editor.replaceSelection(`${before}%% \\split %%${after}`);
        editor.focus();
    }

    // Wraps the current selection as before + selection + after. With nothing selected, inserts
    // the placeholder instead and selects it so the user can type over it immediately.
    private insertFormatting(editor: Editor, before: string, placeholder: string, after: string): void {
        const selection = editor.getSelection();
        const inner = selection || placeholder;
        const fromOffset = editor.posToOffset(editor.getCursor("from"));
        editor.replaceSelection(before + inner + after);
        if (selection) {
            editor.setSelection(editor.offsetToPos(fromOffset + before.length + inner.length + after.length));
        } else {
            editor.setSelection(
                editor.offsetToPos(fromOffset + before.length),
                editor.offsetToPos(fromOffset + before.length + inner.length),
            );
        }
        editor.focus();
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
        // Published links grouped by split part (index-aligned to the note's parsed posts),
        // accumulated across targets so each part's link(s) can be written into its split
        // marker after publishing. Empty for edits and scheduled posts.
        const postLinksByPart: string[][] = [];
        const mergePostLinks = (partLinks: string[][]) => {
            partLinks.forEach((linksForPart, i) => {
                if (linksForPart.length === 0) return;
                (postLinksByPart[i] ??= []).push(...linksForPart);
            });
        };

        try {
            if (isBotMethod) {
                // ── Bot API path ──────────────────────────────────────────────
                const { links, commentLinks, errors, postLinks } = await sendNoteViaBotApi(
                    this.app, file, channel, this.settings,
                    silent, attachUnderText, this.settings.treatMdEmbedsAsComments, updateLink,
                    effectiveMethod === "bot-rich",   // post as Rich Message
                    effectiveMethod === "bot-rich",   // comments follow the post method (rich for "bot + rich")
                );
                allLinks.push(...links);
                allCommentLinks.push(...commentLinks);
                allErrors.push(...errors);
                mergePostLinks(postLinks);
            } else {
                // ── GramJS (User API) path ────────────────────────────────────
                for (const target of targets) {
                    const singleChannel: TelegramChannel = { ...channel, chatId: target.id, chatTitle: target.title, topicId: target.topicId };
                    const { links, commentLinks, errors, scheduled, postLinks } = await sendNoteToTelegram(
                        this.app, file, singleChannel, this.settings, accountSecrets!, silent, attachUnderText,
                        this.settings.treatMdEmbedsAsComments, updateLink, scheduleDate,
                        () => { progressNotice.setMessage(t.NOTICE_PUBLISHING_COMMENTS); },
                        accountPostAsRich,
                    );
                    allLinks.push(...links);
                    allCommentLinks.push(...commentLinks);
                    allErrors.push(...errors);
                    mergePostLinks(postLinks);
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

            // Record each published post's link into its split marker (adding a marker to the
            // last post when it lacks one), so a later edit can match the chosen link back to
            // the exact part. Only for fresh (non-scheduled) publishes — a scheduled post's
            // real link isn't known until it goes live.
            if (this.settings.savePostLinks && !scheduleDate && postLinksByPart.some(l => l && l.length > 0)) {
                await this.writeSplitMarkerLinks(file, postLinksByPart);
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
                } else if (msg.includes("SPLIT_LINK_NOT_FOUND")) {
                    new Notice(t.NOTICE_ERR_SPLIT_LINK_NOT_FOUND);
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
            } else if (msg.includes("SPLIT_LINK_NOT_FOUND")) {
                new Notice(t.NOTICE_ERR_SPLIT_LINK_NOT_FOUND);
            } else {
                new Notice(`${t.NOTICE_ERR_SEND}${errMessage(err)}`);
            }
        }
    }

    // Rewrites the note body so each published post's link lives inside its `%% \split %%`
    // marker (creating a marker for the last post when it has none). Reads the file fresh —
    // any frontmatter written just before is preserved, and the body it parses matches the
    // one that was split for sending, so the per-part links line up. `postLinksByPart` is
    // index-aligned to the note's parsed split posts.
    private async writeSplitMarkerLinks(file: TFile, postLinksByPart: string[][]): Promise<void> {
        const content = await this.app.vault.read(file);
        const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        const frontmatter = fmMatch ? fmMatch[0] : "";
        const body = fmMatch ? content.slice(frontmatter.length) : content;
        const newBody = writeLinksIntoMarkers(body, postLinksByPart);
        if (newBody !== body) await this.app.vault.modify(file, frontmatter + newBody);
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
                        // If the scheduled post came from a split part, write its now-known link
                        // into that part's split marker too (writeLinksIntoMarkers leaves a
                        // non-split note's body untouched).
                        if (task.partIndex !== undefined) {
                            const partLinks: string[][] = [];
                            partLinks[task.partIndex] = [link];
                            await this.writeSplitMarkerLinks(noteFile, partLinks);
                        }
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
