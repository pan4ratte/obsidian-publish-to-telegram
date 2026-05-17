# Changelog

## [2.7.0] — 2026-05-17

### Added
- Global bot token stored in Obsidian SecretStorage (`publish-to-tg-bot-token`).
  Settings UI with Save/Delete buttons and status indication.
- `LimitsWarningModal` — warns before sending content exceeding 4096 characters.
- `AGENTS.md` with GitFlow workflow and SecretStorage documentation.
- Docs folder with project plans and conventions.

### Changed
- **Refactored** Telegram API calls into two helpers (`tgPostJson`, `tgPostForm`),
  removing 9 repetitive `fetch → error-handling` blocks.
- **Extracted** `extractMarkerContent()` helper — removes duplicate marker logic
  between `main.ts` and `telegram.ts`.
- **Pipeline** — content is read and prepared once; pre-formatted result is passed
  directly to `sendNoteToTelegram`, avoiding double processing.
- **Constants** (`CHAR_LIMIT`, `MEDIA_BATCH_MAX`, `DISCUSSION_POLL_MAX/DELAY_MS`)
  extracted from hardcoded values.
- Empty `catch {}` blocks now log to `console.error`.
- `settings` property uses definite assignment (`!`) for strict TS compliance.
- Removed unused `charset` field from `LimitsWarningModal`.

### Removed
- Per-channel `botToken` field from `TelegramChannel` type (consolidated into global token).
- Dead i18n strings (`NOTICE_ERR_INCOMPLETE_PRESET`) and stale `/* REMOVE */` comments.
- `(this.plugin as any)` cast in `MultiPresetModal`.

## [2.6.0] — Previous release
