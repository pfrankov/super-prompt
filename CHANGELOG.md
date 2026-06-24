# Changelog

## 0.2.0 — UI/UX polish + i18n pass

### Added
- Responsive sidebar: collapses to a hamburger drawer below 720px.
- Skeleton loaders on Home, TaskDetail, HistoryTab, DatasetTable.
- Inline form validation (TextField, NumberField) — validates on blur, clears on input.
- Two-step confirm on dataset row delete (no native `confirm()` anywhere in the app).
- Wipe-data moved into a proper `Dialog` with focus trap and ESC to close.
- "Unsaved changes" tag + `beforeunload` warning in TaskEditor.
- Saving indicator on dataset cell edits.
- File-type validation in dataset import (rejects non-`.jsonl|.ndjson|.csv|.tsv`).
- Skip-to-main-content link in AppShell.
- "Drop here" overlay in dataset import when dragging.
- "Saving…" indicator on dataset cell while DB write is in flight.
- New i18n keys: `common.{untitled,unsaved,dropHere,invalidType,saving}`, `home.{confirmDelete,noDescription}`, `history.*`, `compare.perItem.*`, `sidebar.version`, `dataset.{namePlaceholder,generate.extraContext.*,import.rowsTotal}`.

### Changed
- `RunStats` now shows a real "last delta" (child − parent score, ▲ green / ▼ red / — gray); ETA fudge factor removed.
- `ProgressChart` background matches its `var(--bg-2)` surface; x-axis no longer reads "1" when there are no points; ARIA labelledby/describedby set.
- `Settings` wipe uses a proper `Dialog` (was inline `<input>` with native-style confirm).
- `Dialog` opens the close button by default and refuses to let focus escape with Tab when there are no focusables.
- `Toaster` has `aria-live="polite"`.
- `Button` shows a focus ring; `aria-label` is now a first-class prop.
- `Drawer` close button is keyboard-reachable, ESC closes, scrim is `aria-hidden` to screen readers.
- `Sidebar` close-aware: navigating closes the mobile drawer via custom event.
- `TaskEditor` save is now `disabled` until there are unsaved changes.

### Removed
- All `confirm()` / `alert()` calls in `.svelte` files.
- Stale `// Placeholder TaskDetail — filled in Phase C/E` comment.
- Hardcoded `v0.1` literal in Sidebar (now `sidebar.version` i18n key).
- Hardcoded English strings in Home, HistoryTab, CompareModal, GenerateDatasetPanel, DatasetTab, DatasetImportExportDialog.

### Out of scope (deferred)
- GEPA algorithm correctness fixes (parent-selection bias, aggregator pollution on judge-parse-failure, mutator feedback, atomic persistence).
- Worker loop race fixes (module-level control flags).
- Test coverage expansion (judge, mutator, aggregate, retry, sampling).
- DB migration framework.
