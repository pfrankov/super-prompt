# Changelog

## 0.3.0 — Focused prompt refinement

### Changed
- Added the selected SuperPrompt vector logo to both app headers and the favicon
- Reorganized refinement into a guided editor and revision review, with progressive model setup, line-by-line changes, and one primary next action
- Added durable run status and evaluation evidence; moved advanced options and candidate history behind disclosures
- Updated the visual system with a quiet light canvas, precise typography, restrained motion, native dialogs, and keyboard navigation
- Added guarded Undo for the last applied revision, retained across same-tab reload and invalidated by later edits
- Paginated history and comparison choices, bounded dataset page reads, and deferred the editor bundle

### Fixed
- Startup failures retain ownership until their terminal status is saved, including interrupted seed initialization
- Recovered prompt drafts retry persistence and stay visibly unsaved on failure; field-level task writes preserve edits made from other task views
- Failed Pause, Resume and Stop writes keep run ownership and expose recovery instead of allowing an ignored second run
- Preflight and runtime use the same judge verdict contract, including winner and finite-score validation
- Cancelled requests are excluded from evaluation evidence while completed results and returned usage remain recorded
- Initial candidates survive stopping the first iteration, and worker crashes persist a terminal run status before another run can start
- Settings save failures remain visible and retryable without publishing unsaved provider or language changes
- A delayed editor download cannot interrupt typing or shift controls during a fallback-editor interaction
- Stale tabs cannot silently save deleted tasks or create orphan runs and datasets; completed revisions reappear after another task's run finishes
- Example fields keep a stable height while editing, so blur cannot move the next-page control out from under a click
- Prompt-menu dismissal follows native disclosure state, including rapid reopen/Escape and focus changes
- Randomized judge order no longer reverses user-facing A/B labels
- Invalid judge responses no longer count as successful 5/5 ties
- Mutation retries and failed-pair usage are included in reported token totals
- Stop, comparison cancellation, request deadlines, retry waits, and worker recovery now respect their lifecycle
- Prompt edits survive immediate navigation/reload; stale writes cannot recreate deleted tasks or examples
- Generated examples cannot overwrite newly edited manual rows
- JSON extraction preserves Markdown fences inside generated prompt strings

### Validation
- Expanded deterministic API, optimizer, worker, and real IndexedDB regression coverage
- Added exact-head browser CI, synthetic desktop/mobile workflows, and paired baseline/candidate performance evidence
- No data-schema migration, live model calls, or real model-quality claims

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
