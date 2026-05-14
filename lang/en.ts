export default {
    MENU_TITLE: "Publish to Telegram",
    NOTICE_SUCCESS: "Successfully published ✅",
    NOTICE_ERR_CONFIG: "Error: Set up at least one preset.",
    NOTICE_ERR_SEND: "Publishing error: ",
    NOTICE_ERR_NO_DEFAULT: "Error: Default preset is not set up.",
    NOTICE_ERR_INCOMPLETE_PRESET: "Error: Bot token and Chat ID must both be filled in before publishing.",
    SETTING_HEADER: "Publish to Telegram Settings",
    SETTING_DESCRIPTION: "Plugin allows you to post active note to Telegram with hotkeys, command palette and from context menus. Standard Telegram text formatting is supported, as well as photo, album and documents uploads. Advanced publishing settings are available: post to multiple channels/groups at once, silent post and posting media under the text.",
    SETTING_ADD_CHANNEL_NAME: "Set up instructions",
    SETTING_ADD_CHANNEL_DESC: `Plugin works through your personal bot, sending him contents of active note and information about the channel/group to post to. For security reasons, do not transfer control of your bot to third parties.

1. Create a bot using @BotFather and paste its token into the corresponding field in the plugin.
2. Find out your channel/group ID using @userinfobot and paste it into the corresponding field in the plugin.
3. Add your bot to the channel/group and give it permission to send messages.`,
    SETTING_ADD_CHANNEL: "Create new preset",
    SETTING_FORMATTING_HELP: "Usage instructions",
    SETTING_OPEN_BOTFATHER: "Open @BotFather",
    SETTING_OPEN_USERINFOBOT: "Open @userinfobot",
    SETTING_BOT_TOKEN_NAME: "You bot token",
    SETTING_BOT_TOKEN_DESC: "Get it from @BotFather",
    SETTING_CHAT_ID_NAME: "Target channel/group ID",
    SETTING_CHAT_ID_DESC: "Get it from @userinfobot",
    SETTING_DELETE_CHANNEL: "Delete preset",
    SETTING_DEFAULT_CHANNEL: "Set as default preset",
    SETTING_DEFAULT_DESC: "You can publish with default preset using a keyboard shortcut.",
    SETTING_PLACE_HOLDER_NAME: "Enter the preset name...",
    SETTING_PLACEHOLDER_TOKEN: "Enter token...",
    SETTING_PLACEHOLDER_CHAT: "Enter ID...",
    CHANNEL_DEFAULT_NAME: "Channel",
    UNTITLED_CHANNEL: "Unnamed",
    TOOLTIP_EDIT: "Edit name",
    CONFIRM_DELETE_TITLE: "Delete preset?",
    CONFIRM_DELETE_MSG: "Are you sure you want to delete \"{name}\" preset? This action is irreversible.",
    CONFIRM_DELETE_BTN: "Yes, delete",
    CONFIRM_CANCEL_BTN: "Cancel",
    COMMAND_SEND_DEFAULT: "Publish with default preset",
    COMMAND_SEND_MULTIPLE: "Publish with advanced settings",
    COMMAND_SEND_TO_PRESET: "Publish to",
    COMMAND_SHOW_FORMATTING_HELP: "Open usage instructions",
    MULTI_PRESET_TITLE: "Advanced publishing settings",
    MULTI_PRESET_CHANNEL_SELECTION: "Choose channels/groups to post to",
    MULTI_PRESET_ADVANCED_FORMATTING: "Advanced formatting",
    MULTI_PRESET_POST_BTN: "Publish",
    MULTI_PRESET_NO_SELECTION: "Choose at least one preset",
    MULTI_PRESET_SILENT_POST_NAME: "Publish silently",
    MULTI_PRESET_SILENT_POST_DESC: "Subscribers will receive a notification without sound",
    MULTI_PRESET_ATTACHMENTS_NAME: "Attachments below the text",
    MULTI_PRESET_ATTACHMENTS_DESC: "Display post text above the attached media files",
    MULTI_PRESET_UPDATE_HEADING: "Edit post",
    MULTI_PRESET_UPDATE_NAME: "Update existing post",
    MULTI_PRESET_UPDATE_NAME_DESC: "Links are stored in the telegram_links property",
    MULTI_PRESET_UPDATE_NO_OPTION: "Choose a link to the post",
    MULTI_PRESET_UPDATE_LINK_LABEL: "{link}", /* REMOVE */
    MULTI_PRESET_UPDATE_NO_LINKS: "No links found in properties",
    MULTI_PRESET_UPDATE_RESOLVING: "Resolving channel…",
    MULTI_PRESET_UPDATE_WILL_USE: "Will update the post in {name}",
    MULTI_PRESET_UPDATE_NO_MATCH: "Matching preset not found!", /* REMOVE ??? */
    MULTI_PRESET_UPDATE_NO_MATCH_NOTICE: "Matching preset not found for this link!",
    SETTING_SAVE_POST_LINKS_NAME: "Save posts links",
    SETTING_SAVE_POST_LINKS_DESC: "If enabled, the link to the published post will be saved to the note's properties",
    SETTING_MD_EMBEDS_AS_COMMENTS_NAME: "Treat .md embeds as post comments",
    SETTING_MD_EMBEDS_AS_COMMENTS_DESC: "If on, after publishing the bot will send a commentary to the post with the contents of .md embed",
    SETTING_POST_START_MARKER_NAME: "Post start marker",
    SETTING_POST_START_MARKER_DESC: "Text that marks the start of the content to be sent to Telegram",
    SETTING_POST_START_MARKER_PLACEHOLDER: "Enter start marker (e.g. :::post-start-here)",
    SETTING_POST_END_MARKER_NAME: "Post end marker",
    SETTING_POST_END_MARKER_DESC: "Text that marks the end of the content to be sent to Telegram",
    SETTING_POST_END_MARKER_PLACEHOLDER: "Enter end marker (e.g. :::post-end-here)",
    SETTING_LIMITS_INFO_NAME: "Telegram limits",
    SETTING_LIMITS_INFO_DESC: "Information about Telegram posting limits",
    SETTING_LIMITS_INFO_TEXT: "Standard Telegram limits apply: up to 4096 characters for regular bots, and up to 10,000 characters for premium bots. Media limits: photos up to 10 MB, videos up to 50 MB, documents up to 50 MB per file.",
    SETTING_LIMITS_INFO_LINK: "More details: https://limits.tginfo.me/",

    FORMATTING_HELP_CONTENT: `
You can open these instructions from the command palette by typing "Publish to Telegram: Open usage instructions".

### Presets

To publish notes to Telegram, you need to configure a preset.

1. Use the official Telegram tool [@BotFather](https://t.me/BotFather) to create your own bot, following the instructions in the app. If you plan to post to group or make pre-written commentaries for posts, in the bot settings go to the "Bot Settings" menu, find the section "Groups and Channels" and turn of the "Group Privacy" option.

2. Copy your bot's API key in the app and paste this token into the corresponding field in the plugin settings.

3. Use the [@userinfobot](https://t.me/userinfobot) tool to get the ID of the channel/group where you plan to post. You can also get your account ID if you want to use the preset to send messages to yourself (the bot will send you messages to you personally — do not forget to start a conversation with the bot first).

4. Copy the ID of the target channel/group and paste it into the corresponding field in the plugin settings. Alternatively, if you will post to the *public* channel, you can paste to that field the link to the channel in the format \`@channel_name\`.

5. While in Telegram, add the bot you created to the target channel/group and assign it the role of administrator. Give the bot permission to only publish messages.

Now you can publish notes in Telegram using your preset name via the command palette or the note's context menu.

### Formatting

All standard Telegram formatting elements are supported as well as some additional:

<table>
  <thead>
    <tr>
      <th>Obsidian Input</th>
      <th>Telegram Result</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><code>**Bold**</code></td>
      <td><strong>Bold</strong></td>
    </tr>
    <tr>
      <td><code>*Italic*</code></td>
      <td><em>Italic</em></td>
    </tr>
    <tr>
      <td><code>&lt;u&gt;Underline&lt;/u&gt;</code></td>
      <td><u>Underline</u></td>
    </tr>
    <tr>
      <td><code>~~Strikethrough~~</code></td>
      <td><s>Strikethrough</s></td>
    </tr>
    <tr>
      <td><code>&lt;span class="tg-spoiler"&gt;Spoiler&lt;/span&gt;</code></td>
      <td>Spoiler</td>
    </tr>
    <tr>
      <td><code>\`Inline code\`</code></td>
      <td><code>Inline code</code></td>
    </tr>
    <tr>
      <td><code>[Link](url)</code></td>
      <td><a href="https://obsidian.md">Link</a></td>
    </tr>
    <tr>
      <td><code>&gt; Quote</code></td>
      <td><blockquote>Quote</blockquote></td>
    </tr>
    <tr>
      <td><codeblock>\`\`\`<br>Code block<br>\`\`\`</codeblock></td>
      <td><pre><code>Code block</code></pre></td>
    </tr>
    <tr>
      <td><code>- List</code></td>
      <td><ul><li>List</li></ul></td>
    </tr>
    <tr>
      <td><code># Heading</code></td>
      <td><h5>Heading</h5></td>
    </tr>
    <tr>
      <td><code>---</code> or <code>***</code> or <code>___</code></td>
      <td>───</td>
    </tr>
  </tbody>
</table>

In addition to the formatting that will be reflected in the Telegram post, you can use the comment syntax \`<!-- hidden text -->\` or \`%% hidden text %%\` to add information to your notes that will not be included in the post content when it is published.

### Attachments

Media, album (groups of media) and document attachments are supported. To attach a file to your post, use any of the standard Obsidian embed syntax options:

\`![[some-book-file.pdf]]\`

\`![](some-media-file.jpg)\`

\`!(some-video-file.mp4)[]\`

You can also embed files with external web-link embeds:

\`![](https://obsidian.md/image.png)\`

Currently supported formats:

| Extension                                          | Attachment type  |
| -------------------------------------------------- | ---------------- |
| \`.jpg\`, \`.jpeg\`, \`.png\`, \`.webp\`           | Photo / Album    |
| \`.gif\`                                           | Animation        |
| \`.mp4\`, \`.mov\`, \`.avi\`, \`.mkv\`, \`.webm\`  | Video / Album    |
| \`.pdf\`                                           | Document         |

Photos and videos can be freely mixed in the same album post. GIFs are always sent as individual animated messages.

### Commentaries

You can pre-write one or more comments for your post that will appear in its discussion right after the publication. To use that feature:

1. In the plugin settings turn on the option "Treat .md embeds as post comments".

2. If a comment on a post is published in a channel, the channel must have a discussion chat linked to it, and the bot must be added to this chat with administrator rights. If a comment on a post is published in a group, it will appear as a regular reply to a message.

3. To prepare a comment for a post, use the \`![[comment-file]]\` embed syntax. Only files with the .md extension are treated comments.

Note that all comments are published with a slight delay.

### Advanced publishing settings

You can call an advanced publishing settings window with command palette (\`Ctrl + P\`) by typing "Publish to Telegram: Publish with advanced settings". In that settings window you can choose to:

* Post to multiple channels/groups at once.
* Post without sound.
* Post with attached media under the text.
* Edit already existing post. Links to the posts are stored in the \`telegram_links\` property, which is filled automatically if the corresponding option is enablen in the settings. You can also create it and fill manually.

### Limits

Standard Telegram posting limits apply to limits of characters per post, limits of attached media size per post, etc. More about that: [https://limits.tginfo.me/](https://limits.tginfo.me/)
`,
};
