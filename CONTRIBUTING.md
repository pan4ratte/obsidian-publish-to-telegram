# Contributing

## Building

```
npm install
npm run dev       # watch build
npm run build     # production build
npm run lint      # eslint + stylelint
npm test
npx tsc --noEmit  # type-check (esbuild does not)
```

Clone the repository into `<vault>/.obsidian/plugins/` of a test vault: both builds write
`main.js` in place, so reloading the plugin in Obsidian picks up the change.

## Tests

Tests live in `tests/` and run under Node with no Obsidian runtime, so they can only cover
modules that don't import `obsidian` at runtime (`markdown.ts`, `split.ts`, `util.ts`,
`emoji-search.ts`, `emoji-cache.ts`, `proxy-link.ts`). The `test` script in `package.json` lists every test
file explicitly — add a new `*.test.ts` file there, or it won't run.

## Translations

The plugin ships in English and Russian. Every UI string goes into both `lang/en.ts` and
`lang/ru.ts` under the same key, and user-facing documentation changes go into both the
English and the `_RU` file.

## Deferred ideas

Ideas that were investigated and consciously left unimplemented, with the conditions that
would make them worth revisiting. Please read the relevant entry before opening a PR or an
issue for one of these — the reason is usually a platform constraint rather than a lack of
interest.

### Inline buttons under `account-rich` posts

**Status:** deferred (investigated against mtcute 0.32.1, layer 229; rechecked against 0.32.6,
layer 232 — unchanged). The bot methods have had buttons since 6.4.0 (see the end of this entry);
this entry is about the `account-rich` method. The classic `account` method can't have them at
all: the User API only lets bots attach an inline keyboard to a message.

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

The bot methods take the narrower route that needs none of the above: the Bot API's
`reply_markup` / `inline_keyboard`, which `sendRichMessage` accepts as well as the classic send
methods. Buttons are written as a `tg-buttons` code block of `<button>` elements
(`parseButtons` in `src/markdown.ts`, rendered by `src/buttons.ts`) and sent by
`src/telegram-bot.ts`; the account path strips the block and sends no buttons. A code block
rather than raw HTML because Obsidian's sanitizer strips unknown elements and their attributes,
so `<tg-buttons>` could not be rendered in the editor.

### Built-in VPN protocols (VLESS, Shadowsocks, Trojan, …)

**Status:** deferred (checked against mtcute 0.32.3, @fuman/net 0.0.21, Obsidian 1.13.7).

The proxy card supports MTProxy, SOCKS5 and HTTP(S) CONNECT. The protocols most VPN services
in Russia actually run — VLESS (often with Reality), VMess, Shadowsocks, Trojan — are not
built in. Each one is its own framing and cryptography to implement and keep current, and
VLESS + Reality additionally depends on forging a browser's TLS ClientHello, which Node's `tls`
module cannot produce. Every client that speaks these protocols (Hiddify, v2rayN, NekoBox,
Clash) already exposes a local SOCKS5 or HTTP port, and the plugin can use that port today;
the user guide points users to it.

**Revisit when any of these becomes true:**

- A maintained pure-JavaScript client for these protocols appears that runs over Node's `net`.
- Users report VPN clients that expose no local proxy port.

### Proxies on mobile

**Status:** deferred (checked against Obsidian 1.13.7).

A proxy needs raw TCP sockets. Obsidian mobile runs the plugin in a WebView with no socket API:
mtcute can only use WebSockets there and the Bot API only `fetch`/`requestUrl`, and a page can
point neither at a proxy. On mobile the proxy settings are ignored and the card says to use a
system VPN instead.

**Revisit when** Obsidian exposes a socket API, or a per-request proxy option for
`requestUrl`, on mobile.
