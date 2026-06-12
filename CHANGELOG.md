# Changelog

## 4.0.0

### Major update

Version 4.0.0 brings bots back and unifies every posting method into a single, more powerful preset. The headline addition is rich-text formatting for bots, alongside multiple accounts and reusable bot tokens. Now you can:

* **Post as a bot again.** The Bot API posting method returns alongside accounts — a single preset can use either or both. Bots must be channel admins to post, and need "Group Privacy" disabled in @BotFather to post in groups (see the user guide for the full setup).
* **Use rich-text formatting.** Bot presets can post using Telegram's Rich Messages: headings, tables, ordered and task lists, block quotes, collapsible blocks, footnotes, formulas, inline media and more. Pick the "Bot + rich text" method when creating a preset. Rich Messages render only in up-to-date Telegram apps, and their inline media must be added via web (HTTP/HTTPS) links — local file attachments aren't supported with this method; use the "Bot" or "Account" method for those.
* **Send rich-text comments.** Pre-written comments can also be sent as Rich Messages — toggle it in the advanced publishing settings.
* **Add multiple accounts.** Authorize into more than one Telegram account and choose which one each preset posts from.
* **Save and reuse bot tokens.** Bot tokens are stored securely in your Obsidian Keychain, can be named, and reused across multiple presets.
* **Mix posting methods in one preset.** A preset now holds account, bot and bot-with-rich-text configurations together with a default method, and the advanced publishing settings let you switch the method for an individual post.
* **Send .md attachments as documents.** When the "Treat .md embeds as post comments" option is off, embedded .md files are attached to the post as documents.

Upgrading from 3.x is seamless: your authorized account and presets carry over automatically — you don't need to log in again or rebuild your presets, and your previous account becomes the first entry in the new multiple-accounts list.

### UI/UX enhancements and bug fixes

* Authorization cards were completely redesigned.
* Preset sorting was added to the advanced publishing settings.
* General UI/UX cleanup and refinements throughout the plugin.
* New error notification when a "Bot + rich text" post includes local attachments, which Rich Messages don't support.
* New error notification when a bot post's caption exceeds Telegram's 1024-character limit. Classic "Bot" posts now send the note's text as the media caption, in a single combined message.
* READMEs and user guides were updated with full rich-text formatting documentation.
* Locales were updated, corrected and cleaned up.
* Fixed a bug when hashtags in rich-text posts were rendered as headings.
* Fixed a bug when comment links were not saved to the property.
* Fixed rich-text commenting and various UI bugs.
* Various markdown and API parsing fixes.
* Linter fixes.


## 3.1.1

* **Hotfix.** Fixed an bug when changelog and user guide were not opening.

## 3.1.0

### New features

* **Automatic scheduled posts links fetching.** If "Save posts links" option is enabled in the settings and you make a scheduled post, the plugin will create a task to fetch the link after publication. Fetching happens in two scenarios: when Obsidian is open on scheduled time or when you open Obsidian past scheduled time — the link is automatically fetched and inserted to the corresponding property.
* **Edit pre-written comments after publication.** Links to published comments are stored in the separate `tg_comments` property and after publication you can edit them with the advanced publishing settings menu. Note that `telegram_links` property was renamed to `tg_posts`: if you used "Save posts links" feature, be sure to rename already existing property with the Obsidian core plugin [Properties view](https://obsidian.md/help/plugins/properties).
* **View changelog.** Available to view in the settings, the user guide, or via the palette command. Changelog notification in the settings can be dismissed and will not appear until the next update.

### UI/UX enhancements and bug fixes

* New notifications that reflect post/comment editing process.
* Legacy auto-default preset feature removed. Now, if you have only one preset and try to post with the default option` and it is not set up, advanced publishing settings menu will open.
* GramJS `localStorage` API schema cache was disabled to avoid triggering linter issues.
* Fixed UI bugs in the advanced settings.
* Various markdown parsing fixes by @egorgvo.


## 3.0.1

* **Hotfix.** Security and stability updates.


## 3.0.0

### Major update

Version 3.0.0 of the plugin presents the biggest update since the beginning of development. The main change is migration from Bot API to User API with many enhancements. Now you can:

* **Authorize into your Telegram account.** No bot creation or any complex setup processes anymore!
* **Post, using Telegram Premium features.** If you have Telegram Premium, for example, you can send media attachments with text up to 4096 symbols (instead of 1024 with bots).
* **Schedule posts.** To do that, just open advanced publishing settings, pick a date and send the post.
* **Search chats in presets.** Presets were completely reimagined and now you can use search field to find target chats: your chat history will automatically load. The option to enter chat its `@username` or `ID` manually us still preserved.
* **Add multiple targets to one preset** Now every preset can hold multiple channels, groups, *forum topics*, chats and bots as publishing targets.

### UI/UX enhancements and bug fixes

* Plugin UI was generally cleaned up and restructured.
* New notifications that reflect posting process.
* Default preset feature updated: if no preset is set as the default, the Advanced publishing settings menu will open.
* Advanced publishing settings option was added to the context menu.
* New error notification when an attempt to publish is made, but the user is not logged in.
* New error notification when an attempt to update the post is made, but no text was changed.
* READMEs and user guide are updated to reflect all changes and new features.
* Startup time was optimized.
* Locales are updated, corrected and cleaned up.
* Fixed a bug when video attachments were sent as GIFs.
* Fixed a bug when pre-written comments were not sent.
* Fixed a bug when "Media attachments below the text" feature didn't work.

Thanks to @egorgvo for his valuable backend contributions.
Thanks to @aevxofficial for the idea to add posting to forum topics feature.
