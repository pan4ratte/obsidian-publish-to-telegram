You can open these instructions from the command palette by typing "Publish to Telegram: Open user guide". You can also [view changelog](obsidian://command?id=publish-to-telegram:show-changelog) of the latest updates.

### Presets

To publish notes to Telegram, you need to configure a preset.

1. In the plugin settings, log in to your account and make sure you have the relevant permissions to post to the target channels/groups. Phone number and QR authorizations are available.

2. Create a new preset and click on the search field to load chat list. You can also enter `@username` or `ID` manually. You can get the `ID` of any user, channel, or group with [@userinfobot](https://t.me/userinfobot).

3. Add one or multiple target channels, groups, forum topics, chats or bots to the preset.

Now you can post notes to Telegram using your preset's name via the command palette, the note's context menu, or keyboard shortcuts.

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
      <td><code>&lt;tg-spoiler&gt;Spoiler&lt;/tg-spoiler&gt;</code></td>
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
      <td><code>- List</code> or <code>* List</code> or <code>+ List</code></td>
      <td><ul><li>List</li></ul></td>
    </tr>
    <tr>
      <td><code>1. List</code> or <code>1) List</code></td>
      <td>1. List or 1) List</td>
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

#### Omitting text from a post

In addition to the formatting that will be reflected in the Telegram post, you can use the comment syntax `<!-- hidden text -->` or `%% hidden text %%` to add information to your notes that will not be included in the post content when it is published.

#### Splitting the note into multiple posts

You can also use the special command `<!-- \split -->` or `%% \split %%` to split the text of your note into separate posts. If you use this command, the plugin will publish all posts at the same time. Attachments (see below), including pre-written comments, must appear before the special command that marks the end of the post.

### Attachments

Media, album (groups of media) and document attachments are supported. To attach a file to your post, use any of the standard Obsidian embed syntax options:

`![[some-book-file.pdf]]`

`![](some-media-file.jpg)`

`!(some-video-file.mp4)[]`

You can also embed files with external web-link embeds:

`![](https://obsidian.md/image.png)`

Currently supported formats:

| Extension                                           | Attachment type  |
| --------------------------------------------------- | ---------------- |
| `.jpg`, `.jpeg`, `.png`, `.webp`                    | Photo / Album    |
| `.gif`                                              | Animation        |
| `.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`             | Video / Album    |
| `.pdf`, `.md`                                       | Document         |

### Pre-written comments

You can pre-write one or more comments for your post that will appear in its discussion right after the publication. To use that feature:

1. In the plugin settings turn on the option "Treat .md embeds as post comments".

2. To prepare a comment for a post, use the `![[comment-file]]` embed syntax. Only files with the .md extension are treated comments.

A couple of notes:

* If a comment on a post is published in a group or in personal messages, it will appear as a regular reply to a message.

* If you split the note into multiple posts (see above), you can attach the comments to each of the posts. To do that, place .md-embeds before the corresponding marker.

* All comments are published with a slight delay.

* For now, it is not possible to schedule pre-written comments.

### Advanced publishing settings

You can open an advanced publishing settings window with command palette (`Ctrl + P`) by typing "Publish to Telegram: Publish with advanced settings". In that settings window you can choose to:

* Post, using multiple presets at once.

* Post without sound.

* Post with attached media under the text.

* Schedule the publication.

* Edit already existing posts or pre-written comments. Links are stored in the `tg_posts` and `tg_comments` properties, that are filled automatically if the corresponding option is enabled in the settings. You can also create them and fill manually.

### Limits

Standard Telegram posting limits apply to limits of characters per post, limits of attached media size per post, etc. More about that: [https://limits.tginfo.me/](https://limits.tginfo.me/)

I also highly recommend my other plugin, [Advanced Word Count](https://community.obsidian.md/plugins/advanced-word-count), which lets you create detailed presets for word counts in notes and offers significantly greater functionality compared to the standard Obsidian word counter. This plugin can be configured to count characters exactly the same way Telegram does.

---

## About the Author

My name is Mark Ingram (Ingrem), I am a Religious Studies scholar. Apart from my main area of study (Protestant Political Theology in Russia), I teach the subject "Information Technologies in Scientific Research", a unique course that I developed myself from scratch. This plugin helps me in my studies and I use it in my teaching, as well as other plugins that I develop and that you can find on [my GitHub profile](https://github.com/pan4ratte/).

Hello to every student that came across this page!

Huge thanks to [Egor Gvozdikov](https://github.com/egorgvo), who wrote the first lines of code for this project and made numerous valuable commits.
