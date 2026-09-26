# AGENTS.md

Guidance for AI coding agents working in this repository. Read `CONTRIBUTING.md` as well —
especially **Deferred ideas**, which lists features that were investigated and rejected, and
why.

## Project

**Publish to Telegram** is an Obsidian plugin (`manifest.json` id `publish-to-telegram`,
min app 1.13.0, desktop and mobile) that posts notes to Telegram chats, groups, forum topics
and channels. It has four publishing methods (`PostMethod` in `src/types.ts`):

| Method         | Path                  | Engine                          |
| -------------- | --------------------- | ------------------------------- |
| `account`      | `src/telegram.ts`     | User API via mtcute             |
| `account-rich` | `src/telegram.ts`     | mtcute, Rich Messages (Premium) |
| `bot`          | `src/telegram-bot.ts` | Bot API over HTTPS              |
| `bot-rich`     | `src/telegram-bot.ts` | Bot API, Rich Messages          |

## Commands

```
npm run dev       # watch build → main.js
npm run build     # production build
npm run lint      # eslint (type-aware, eslint-plugin-obsidianmd)
npm test          # esbuild-bundles tests/*.test.ts, runs them with node --test
npx tsc --noEmit  # type-check — esbuild does not
```

Run `npm run lint` and `npm test` after changes, and `npx tsc --noEmit` to make sure you
haven't added type errors. The repository is checked out inside a development vault's
`.obsidian/plugins/` folder, so `main.js` is the live plugin — there is no separate deploy step.

## Layout

- `main.ts` — plugin class: commands, editor/file menus, settings load/save and migrations,
  scheduled-link resolution. Entry point for esbuild.
- `src/gui.ts` — all UI: settings tab (declarative `getSettingDefinitions()` API), the
  advanced publishing modal (`MultiPresetModal`), auth panels, chat picker, changelog and
  formatting-help modals. The largest file by far.
- `src/telegram.ts` — account send/edit paths, mtcute client creation, dialogs, scheduled posts.
- `src/telegram-bot.ts` — bot send/edit paths. Self-contained; imports only `markdown.ts`,
  `split.ts` and Obsidian.
- `src/markdown.ts` — Obsidian markdown → Telegram HTML (classic) and → Rich Markdown (rich).
- `src/split.ts` — `%% \split %%` markers: splitting a note into posts and writing published
  links back into the markers. No Obsidian/Telegram imports.
- `src/emoji*.ts`, `src/custom-emoji.ts` — emoji bar, bundled emoji data (generated —
  don't hand-edit `emoji-data.ts`), custom (Premium) emoji and their preview cache.
- `src/types.ts` — settings and data model, `DEFAULT_SETTINGS`.
- `lang/en.ts`, `lang/ru.ts`, `lang/helpers.ts` — UI strings (`t.KEY`); the helpers also import
  the user guide and changelog `.md` files, which are bundled as text and shown in-app.
- `shims/` — browser shims for Node built-ins mtcute expects (see `esbuild.config.mjs`).
- `tests/` — Node tests for the Obsidian-free modules only.

## Constraints and gotchas

- **Bundling.** `obsidian`, `electron`, `@codemirror/*` and `@lezer/*` must stay external —
  a second CodeMirror copy breaks the editor extension. Keep `target: chrome110`; it stops
  esbuild emitting `Uint8Array.fromBase64` for the inlined mtcute wasm. Don't add a `crypto`
  shim (see the comment in `esbuild.config.mjs`).
- **Rich Messages are sent as server-parsed markdown** (`type: "markdown"`). Don't switch to the
  `blocks` form — see "Inline buttons under a post" in `CONTRIBUTING.md`.
- **Classic posts must be one message.** If a classic (non-rich) post's attachments would
  produce more than one message, it is refused up front (`MIXED_MEDIA_CLASSIC`) rather than
  sent in pieces. The account path also refuses photo+video albums. This is deliberate — don't
  add a per-item fallback.
- **Secrets never go in `data.json`.** Account sessions, API credentials and bot tokens live in
  `app.secretStorage`; settings only hold ids that reference them. `data.json` is gitignored
  and contains real settings — never commit it.
- **Lint rules come from `eslint-plugin-obsidianmd`**: use `window.setTimeout` and friends,
  `void` or handle promises, no inline styles, etc. Fix the code rather than disabling a rule.
- **Settings tab:** custom DOM in a declarative-settings `render` callback must go inside
  `setting.settingEl`. Anything appended to `group.listEl` is removed by Obsidian after render.
- **`AbstractInputSuggest`:** return a `Promise` from `getSuggestions` instead of calling
  `open()` after async work — `open()` is a no-op once the suggest has opened empty.
- **Icons:** `setIcon` takes Lucide icon names only; an unknown name renders an empty button.
- **CSS:** all classes are prefixed `telegram-` and live in `styles.css`.

## Localisation and documentation

- Every UI string goes into both `lang/en.ts` and `lang/ru.ts` under the same key.
- **Russian is the source.** The maintainer writes `CHANGELOG_RU.md`, `README_RU.md` and
  `USER_GUIDE_RU.md` first; the English files are translations and must mirror them exactly —
  same sections, same bullet count and order, including removals.
- The user guide body (sections 1–8) appears in all four of `README.md`, `README_RU.md`,
  `USER_GUIDE.md` and `USER_GUIDE_RU.md`. The Features section is only in the two READMEs.
  When syncing, change only the section that was edited; don't write new prose unless asked.
- **Changelog:** newest version first, bare `## x.y.z` headings, one short bullet per
  user-visible change — no notes, causes or caveats. Section headings:
  - `### UI/UX enhancements and bug fixes` / `### UI/UX улучшения и исправления багов`
  - `### New features` / `### Новые возможности`
  - `### Major update: …` / `### Крупное обновление: …` (x.0.0 only)
  - hotfix releases have no subheading, just one bullet: `* **Hotfix.** …` / `* **Хотфикс.** …`

  Leave two blank lines before each `##`.
- When you investigate a feature and decide not to build it, add an entry under
  **Deferred ideas** in `CONTRIBUTING.md`: the versions it was checked against, the blocker,
  and when to revisit. Leave a pointer comment in the code where someone would reach for it.

## Releases and git

- Pushing a `manifest.json` version bump to `main` triggers `.github/workflows/main.yml`,
  which builds, attests and publishes a GitHub release. Its notes are the `## x.y.z` section of
  `CHANGELOG.md`. `manifest.json` and `package.json` versions must match or the workflow fails;
  also update `package-lock.json` and add the version to `versions.json`.
- Don't commit, push or release unless the maintainer asks.
- Don't add `Co-Authored-By` or other AI attribution trailers to commits.
