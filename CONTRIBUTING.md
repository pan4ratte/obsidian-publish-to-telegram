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

## Manual test notes

`test-notes/` holds the notes used to check the plugin by hand in Obsidian: one note per
feature, in folders that follow the sections of the user guide, and `13 Ошибки` for posts that
are expected to fail. Like the rest of the maintainer's material, they are written in Russian.
Each note's `note` property says what it tests, and a `%% … %%` block at the top lists the
methods, the steps and the expected result; it is an Obsidian comment, so it is never published.

```
npm run test-notes -- push [vault-folder] [--force]   # copy the notes into a vault
npm run test-notes -- pull [vault-folder]             # bring edits back into the repository
```

The vault folder defaults to `Publish to Telegram` in the vault the plugin is installed in.
Publishing writes post links into the notes; `pull` strips them and `push` ignores them, so
they never reach the repository. `push` doesn't overwrite a note that was changed in the vault
unless you pass `--force`. `pull` only takes files under top-level folders that already exist
in `test-notes/`, so create a new folder there first. Neither command deletes files.

Every new feature needs its own new test note, and the feature isn't done until that note
passes: published in Obsidian, the result matches what the note expects. Add the note in the
same pull request as the feature; put its error cases in a separate note in `13 Ошибки`.

Every attachment is generated or freely licensed — keep it that way: no copyrighted media and
no personal posts. Don't put a literal `%%` inside a note's instruction block, because it ends
the comment early.

## Translations

The plugin ships in English and Russian. Every UI string goes into both `lang/en.ts` and
`lang/ru.ts` under the same key, and user-facing documentation changes go into both the
English and the `_RU` file.

## Deferred ideas

Ideas that were investigated and consciously left unimplemented, with the conditions that
would make them worth revisiting. Please read the relevant entry before opening a PR or an
issue for one of these — the reason is usually a platform constraint rather than a lack of
interest.

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
