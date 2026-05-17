# AGENTS.md — obsidian-publish-to-telegram

## GitFlow

- `main` — production-релизы
- `develop` — интеграционная ветка
- Фичи: `feature/<name>` от `develop`, PR → `develop`
- Релизы: `release/<version>` от `develop`, PR → `main` + обратно в `develop`
- Хотфиксы: `hotfix/<name>` от `main`, PR → `main` + `develop`
- Прямые коммиты в `main`/`develop` запрещены. Всегда создавай feature-ветку.

## Commit format

Conventional Commits: `<type>(<scope>): <description>`

Типы: `feat`, `fix`, `chore`, `refactor`, `docs`, `style`, `test`, `perf`, `build`
- `feature/*` → feat, refactor, test
- `hotfix/*` → fix
- `release/*` → chore, docs, fix

Описание в повелительном наклонении, до 72 символов. Тело коммита (опционально) — с новой строки, поясняет причину изменения.

## Build & verify

```sh
npm run dev     # esbuild watch → main.js (unminified)
npm run build   # esbuild production → main.js (minified)
npx tsc --noEmit   # typecheck (not in package.json scripts, but tsconfig is strict)
```

No test suite exists. Verify by building and loading in Obsidian.

## Architecture

- **Entrypoint**: `main.ts` exports `SendToTelegramPlugin` (default export). Compiled via esbuild into single-file `main.js`.
- **`obsidian` is external** — never bundled. Listed in `devDependencies` only for types.
- **Core modules** under `src/`:
  - `types.ts` — `TelegramChannel`, `TelegramSettings`, `DEFAULT_SETTINGS`
  - `telegram.ts` — all Telegram Bot API interaction, content formatting, attachment handling
  - `gui.ts` — settings tab (`TelegramSettingTab`), modals (`MultiPresetModal`, `FormattingHelpModal`, `ConfirmationModal`)
- **i18n**: `lang/helpers.ts` picks `en` or `ru` via `moment.locale()`. Add new locale files in `lang/` and register in `localeMap`.
- **Only runtime dependency**: `telegram-markdown-v2` (Obsidian MD → Telegram MarkdownV2 conversion).

## Key conventions

- **Bot token**: single global token stored via `app.secretStorage` (sync API: `.getSecret()`/`.setSecret()`) under the name `publish-to-tg-bot-token`. Get/set via `plugin.getBotToken()` / `plugin.saveBotToken()` / `plugin.removeBotToken()`.
- **Post links**: stored in frontmatter property `telegram_links` (array of strings). Auto-saved when `settings.savePostLinks` is true.
- **Content markers**: default `:::post-start-here` / `:::post-end-here` — only text between them is published. Configurable per-channel and globally.
- **Hidden content**: `%% ... %%` and `<!-- ... -->` are stripped before sending.
- **Media embeds**: `![[file]]`, `![]()`, `!()[]` syntaxes all supported. `.md` embeds become post comments when `treatMdEmbedsAsComments` is on.
- **Channel commands**: dynamically registered per channel via `syncChannelCommands()`. Re-registered on every settings save.
- **Limits warning**: before sending, content length is checked against 4096-char Telegram limit. If exceeded, `LimitsWarningModal` asks user to confirm.

## SecretStorage (Obsidian keychain)

- Available from Obsidian **1.11.4+** via `this.app.secretStorage` (NOT `app.vault.getSecretStorage()` — that's a legacy API).
- Methods: `.getSecret(id): string | null`, `.setSecret(id, secret): void`, `.listSecrets(): string[]` (all **synchronous**).
- **ID constraint**: lowercase alphanumeric + optional dashes only. Uppercase letters throw `Error`.
- **Always wrap in try/catch** — `setSecret()` throws on invalid ID, `getSecret()` may not exist in older Obsidian.
- Canonical pattern (from singularity-sync):
  ```
  const ss: any = (this.app as any)?.secretStorage;
  if (ss && typeof ss.setSecret === "function") {
      ss.setSecret("my-key", value);
  }
  ```
- UX pattern: keep input field empty (no pre-fill), Save/Delete buttons, status text (`✓ saved` / `⛔ not set`).

## Editing notes

- Edit `.ts` source files only. `main.js` is the build output (gitignored, rebuilt on `npm run build`).
- Settings UI strings live in `lang/en.ts` (and `lang/ru.ts`).
- Plugin metadata (`id`, `version`, `minAppVersion`) is in `manifest.json` — keep in sync with `package.json`.
