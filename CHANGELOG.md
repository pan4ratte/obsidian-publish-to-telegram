# Changelog

## 5.1.0

### New features

* Posts in a note split into parts with the `\split` command can now be edited. After such posts are published, the link to each post is written automatically inside its `\split` command (e.g. `%% \split t.me/channel/123 %%`), and when you edit a post the plugin matches the link you chose to the link inside the `\split` command. Important reminder: the command marks the *end* of a post.

### UI/UX enhancements and bug fixes

* Fixed a bug where attachments, text and pre-written comments hidden with `%% … %%` or `<!-- … -->` comments were still published.
* Fixed a bug where comment syntax inside inline code or a code block was removed from the published post.


## 5.0.3

### UI/UX enhancements and bug fixes

* Added deletion of duplicate sessions. When you authorize into already added account, new session is saved and the old one is deleted.
* Fixed a bug when it was impossible to add local media to the rich-text post on edit.
* Fixed a bug that broke comments publication with account methods.


## 5.0.2

### UI/UX enhancements and bug fixes

* Fixed a bug where a photo (or other attachment) added to an existing post did not appear when editing.
* Fixed a bug where editing a rich-text post converted it into a classic message.
* Fixed a bug where posting to a forum topic always opened the advanced publishing settings menu.
* Fixed a bug where editing a post in a forum topic was impossible due to incorrect link handling.
* When you select a link to edit a post that lives in a forum topic, the topic's name is now shown next to the group/channel name.
* When editing a post or a comment, the options that don't apply to edits are now disabled in the advanced publishing settings.


## 5.0.0

### Major update: rich-text formatting support for accounts

On [July 15, 2026](https://telegram.org/blog/communities-editor-invisible-messages) Telegram opened its Rich Text Editor to users with Telegram Premium. With this update the plugin gains a new posting method, "Account + rich text" — now you can publish rich-text posts as your own account:

* **Post rich-text as an account.** Pick the new "Account + rich text" method when creating a preset or in the advanced publishing settings.
* **Local media in rich messages.** Unlike bots, which can only attach media by web embedding (an HTTP/HTTPS link), "Account + rich text" lets you attach local media to posts. One important limitation: local documents (e.g. PDFs) can't be attached to rich-text messages.
* **Telegram Premium required.** Sending rich-text as an account is a Premium feature on Telegram's side. If you don't have Premium, you can use the "Bot + rich text" publication method.

Please note: this update affects user sessions, so a one-time re-login to your accounts is required. Your saved presets and bot tokens are unaffected.

### UI/UX enhancements and bug fixes

* Improved detection of unsupported attachment combinations. When you try to send attachment sets that classic methods don't support, the post is not sent and an error is shown. The same happens when attachment count limits are exceeded.
* Fixed a bug where basic groups upgraded to supergroups still appeared in the chat search field — such groups are now filtered out and only working chats are shown.
* Completed the full migration of the User API from the deprecated GramJS to the current [mtcute](https://github.com/mtcute/mtcute); the plugin code was slimmed down.

## 4.0.0

### Major update: bots with rich-text formatting support

Version 4.0.0 brings bots back with a more important purpose: a full support of rich-text messages feature, intorduced by Telegram on [June 11, 2026](https://telegram.org/blog/watch-apps-and-more/#obscenely-rich-text-formatting-for-bots) only for bots. This is the biggest formatting update in the history of Telegram, which is great news for writers and admins. For example, post symbol limit is 32.000 now. Moreover, we introduce multiple accounts and reusable bot tokens support. Now you can:

* **Post as a bot again.** The Bot API posting method is back, alongside accounts. Any preset can post as an account, as a bot with classic text formatting and completely new, heavily extended rich-text formatting. See user guide to learn, how to use bot features properly.
* **Post rich-text messages.** Bot presets can post using Telegram's Rich Messages: headings, tables, ordered and task lists, block quotes, collapsible blocks, footnotes, formulas, inline media and more. Pick the "Bot + rich text" method when creating a preset or in the advanced publishing settings later. One important limitation, *imposed by Telegram*: Rich Messages can accept only web-embedded media (HTTP/HTTPS links), local file attachments are not supported.
* **Send rich-text comments.** Pre-written comments are send with the same publication method as the post.
* **Add multiple accounts.** Authorize into more than one Telegram account and choose which one each preset posts from.
* **Save and reuse bot tokens.** Bot tokens are now stored securely in your Obsidian Keychain, can be named, and reused across multiple presets.
* **Send .md attachments as documents.** When the "Treat .md embeds as post comments" option is off, embedded .md files are attached to the post as documents.

Upgrading from 3.x should be seamless: your authorized account and presets carry over automatically — you don't need to log in again or rebuild your presets, and your previous account becomes the first entry in the new multiple-accounts list.

### UI/UX enhancements and bug fixes

* Authorization and preset cards were completely redesigned.
* READMEs and User guides were updated with full rich-text formatting documentation.
* Various markdown and API parsing fixes.


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
