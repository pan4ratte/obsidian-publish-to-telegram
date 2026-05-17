# Publish to Telegram plugin

English | [Русский](https://github.com/pan4ratte/obsidian-publish-to-telegram/blob/main/README_RU.md)

![](media/plugin-demo-settings.png)

This plugin allows you to post notes directly to Telegram channels and groups with different presets. The plugin works through your personal bot, sending to it contents of an active note and information about the channel/group to post to. All standard Telegram formatting options are supported, as well as photo, album and document uploads, plus some advanced publishing settings are available.


## Features

1. Create multiple presets to post to different channels and groups.

2. Post in different ways: with hotkeys, command palette and context menus.

3. Attach photos, videos, albums and documents to your posts.

4. Use advanced publishing settings to:

  	* Post to multiple channels/groups at once.
  	* Post without sound.
  	* Post with attached media under the text.
    * Edit already existing post.

5. Attach pre-written commentaries to your posts that will be displayed in the post's discussion after its publication.

6. Set a default preset to post quickly with it from command palette or with hotkey.

7. Optionally enable automatic link to the post saving in the note's properties after publishing.   

8. Open usage instructions either from the plugin's settings or from the command palette.


## Installation Instructions

Before plugin appears in the official Obsidian store, the easiest way to install it is through the `BRAT` plugin:

1. Install the `BRAT` plugin from the official Obsidian plugin store.

2. In the `BRAT` settings, find the “Beta plugin list” section and click on the “Add beta plugin” button.

3. In the window that appears, paste the link to the `Publish to Telegram` plugin repository: [https://github.com/pan4ratte/obsidian-publish-to-telegram](https://github.com/pan4ratte/obsidian-publish-to-telegram)

4. Under “Select a version” choose “Latest version” and click the “Add plugin” button.

Done! The plugin will automatically install and will be ready to use.


## Usage

### Presets

To publish notes to Telegram, you need to configure a preset.

1. Use the official Telegram tool [@BotFather](https://t.me/BotFather) to create your own bot, following the instructions in the app. If you plan to post to group or make pre-written commentaries for posts, in the bot settings go to the "Bot Settings" menu, find the section "Groups and Channels" and turn of the "Group Privacy" option.

2. Copy your bot's API key in the app and paste it into the **Bot token** field at the top of the plugin settings, then click **Save**. The token is stored securely in Obsidian's built-in keychain (SecretStorage), not in plain text. You can delete it at any time with the **Delete** button.

3. Use the [@userinfobot](https://t.me/userinfobot) tool to get the ID of the channel/group where you plan to post. You can also get your account ID if you want to use the preset to send messages to yourself (the bot will send you messages to you personally — do not forget to start a conversation with the bot first).

4. Copy the ID of the target channel/group and paste it into the corresponding field in the plugin settings. Alternatively, if you will post to the *public* channel, you can paste to that field the link to the channel in the format `@channel_name`.

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
      <td><code>`Inline code`</code></td>
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
      <td><codeblock>```<br>Code block<br>```</codeblock></td>
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

In addition to the formatting that will be reflected in the Telegram post, you can use the comment syntax `<!-- hidden text -->` or `%% hidden text %%` to add information to your notes that will not be included in the post content when it is published.

### Content markers

You can publish only a specific part of a note by using **start** and **end markers**. Only the text between the markers will be sent to Telegram.

Default markers:
- Start marker: `:::post-start-here`
- End marker: `:::post-end-here`

You can configure custom markers globally in the plugin settings, or override them per preset. If no markers are found in the note, the entire note content is published.

### Attachments

Media, album (groups of media) and document attachments are supported. To attach a file to your post, use any of the standard Obsidian embed syntax options:

`![[some-book-file.pdf]]`

`![](some-media-file.jpg)`

`!(some-video-file.mp4)[]`

You can also embed files with external web-link embeds:

`![](https://obsidian.md/image.png)`

Currently supported formats:

| Extension                                          | Attachment type |
| -------------------------------------------------- | --------------- |
| `.jpg`, `.jpeg`, `.png`, `.webp` 		             	 | Photo / Album   |
| `.gif`                                             | Animation       |
| `.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`            | Video / Album   |
| `.pdf`                                             | Document        |

### Commentaries

You can pre-write one or more comments for your post that will appear in its discussion right after the publication. To use that feature:

1. In the plugin settings turn on the option "Treat .md embeds as post comments".

2. If a comment on a post is published in a channel, the channel must have a discussion chat linked to it, and the bot must be added to this chat with administrator rights. If a comment on a post is published in a group, it will appear as a regular reply to a message.

3. To prepare a comment for a post, use the `![[comment-file]]` embed syntax. Only files with the .md extension are treated comments.

Note that all comments are published with a slight delay.

### Advanced publishing settings

You can call an advanced publishing settings window with command palette (`Ctrl + P`) by typing "Publish to Telegram: Publish with advanced settings". In that settings window you can choose to:

* Post to multiple channels/groups at once.
* Post without sound.
* Post with attached media under the text.
* Edit already existing post. Links to the posts are stored in the `telegram_links` property, which is filled automatically if the corresponding option is enabled in the settings. You can also create it and fill manually.

### Limits

Standard Telegram posting limits apply to limits of characters per post, limits of attached media size per post, etc. More about that: [https://limits.tginfo.me/](https://limits.tginfo.me/)

## About the Author

My name is Mark Ingram (Ingrem), I am a Religious Studies scholar. Apart from my main area of study (Protestant Political Theology in Russia), I teach the subject "Information Technologies in Scientific Research", a unique course that I developed myself from scratch. This plugin helps me in my studies and I use it in my teaching, as well as other plugins that I develop and that you can find on my GitHub profile.

Hello to every student that came across this page!

Huge thanks to [Egor Gvozdikov](https://github.com/egorgvo), who wrote the first lines of code for this project and made numerous valuable commits.
