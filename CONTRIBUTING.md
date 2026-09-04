# Contributing

## Building

```
npm install
npm run dev     # watch build
npm run build   # production build
npm run lint
npm test
```

## Deferred ideas

Ideas that were investigated and consciously left unimplemented, with the conditions that
would make them worth revisiting. Please read the relevant entry before opening a PR or an
issue for one of these — the reason is usually a platform constraint rather than a lack of
interest.

### Inline buttons under a post

**Status:** deferred (investigated against mtcute 0.32.1, layer 229).

mtcute 0.32.0 added `Rich.buttonRow()`, `Rich.button()` and `Rich.textButton()`, which build
`pageBlockButtonRow` / `pageButton` / `textButton` objects. It is tempting to use them to put
tappable URL buttons under a published post.

They cannot be used as the plugin currently sends rich messages. Telegram's three rich-message
input constructors are mutually exclusive:

```
inputRichMessageMarkdown { markdown, files }        ← what this plugin sends
inputRichMessageHTML     { html, files }
inputRichMessage         { blocks, photos, ... }    ← the only one that can hold buttons
```

Buttons are page *blocks*, so they exist only in the third form, and mtcute's
`_normalizeInputRichMessage` only emits that form when the caller passes `type: "blocks"`.
There is no way to attach a button row to a server-parsed markdown message.

The plugin sends `type: "markdown"` and relies on Telegram's server-side Rich Markdown parser
for the whole document: headings, tables, task lists, math, fenced code, `<tg-collage>`,
`<tg-slideshow>`, `<details>`, custom-emoji tags, and the blank-line handling in
`materializeBlankLines` (`src/markdown.ts`). Switching to the blocks form means writing a
client-side replacement for that parser. Every construct the replacement failed to cover would
render worse than it does today — a rewrite of the plugin's rendering core in exchange for one
row of buttons.

**Revisit when any of these becomes true:**

- Telegram allows a button row alongside `inputRichMessageMarkdown` (i.e. a `files`-style
  side-channel for blocks), which removes the trade-off entirely.
- mtcute ships a markdown → page-blocks converter, so the blocks form can be adopted without
  hand-writing the parser.
- The plugin needs the blocks form for some other reason and pays the conversion cost anyway —
  at that point buttons are nearly free.

A narrower alternative that does **not** require any of the above: the Bot API's
`reply_markup` / `inline_keyboard` on the `bot` and `bot-rich` methods. That leaves rendering
untouched, but gives nothing to the `account-rich` method, and it has not been checked whether
`sendRichMessage` accepts `reply_markup`.
