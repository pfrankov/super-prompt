# Super-Prompt

A local-first workspace for iteratively improving a system prompt. Choose a target model and an arbiter, evaluate answers against examples, compare revisions, and keep the prompt you want to use.

Tasks, examples, model settings, and run history stay in your browser. Optimization runs in a Web Worker. There is no application backend or telemetry.

## Quickstart

Use Node.js 24 and npm:

```bash
npm ci
npm run dev
npm test
npm run check
npm run build
npm run preview
```

Open **Improve prompt**, paste your prompt, then **Configure models**. **Use demo** runs the complete workflow with synthetic local responses and no API calls. Demo scores demonstrate the interface; they do not measure real prompt quality.

## Configure models

- **Target:** the OpenAI-compatible base URL, API key, and model that will answer using your prompt
- **Arbiter:** the model that scores answers and proposes revisions. Enable a separate provider to use another endpoint/key/model for this role
- **Settings:** request deadlines, retry limits, per-model rate limits, and language

API keys are stored in IndexedDB in plain text. Anyone with access to this browser profile can read them. Keys are sent to the provider you configure; there is no remote synchronization. Use a trusted endpoint and an appropriately limited key. Local Ollama and the built-in demo can work without a key.

The provider must support browser CORS and OpenAI-compatible `/chat/completions`. Connection testing uses `/models`; successful model listing does not guarantee chat-completion access.

## Refine a prompt

1. Enter the prompt and configure both model roles
2. Add at least two examples, or let the app generate examples before the run. Manually edited examples are preserved
3. Start refinement. The worker selects a candidate, proposes a revision, samples examples, and asks the arbiter to compare the answers in randomized order
4. Inspect the best evaluated prompt and its evidence. Scores are judgments on sampled examples, not a guarantee of real-world quality; mutation rationale describes the proposed change rather than proving it worked
5. Compare current/result prompts, copy or export the result, or apply it as the next starting prompt

Pause takes effect between iterations. Stop cancels pending requests; a provider may still charge for work already started. Navigating between tabs preserves a live run. Reloading ends the worker and marks an interrupted run stopped when it is reopened.

Prompt edits are saved automatically. A temporary session-storage draft protects the latest prompt during reload and is cleared after the matching IndexedDB write. A pending/failed save warns before leaving. Other task fields in Overview use the explicit Save action.

## Architecture

- **UI:** Svelte 5, native accessible dialogs, responsive design tokens, reduced-motion support. CodeMirror loads only when an editor is needed, with a usable textarea fallback
- **Worker:** optimization, provider calls, candidate selection, scoring, and usage tracking in `src/worker/`
- **Storage:** IndexedDB via `idb`, schema version 1 with eight stores. This release does not migrate or clear existing data
- **History:** 20 run rows per page; up to eight scored candidate records load on disclosure
- **Examples:** cursor-based 10-row pages. Comparison renders 20 example choices at a time
- **Language:** bundled English/Russian catalogs through the local `svelte-i18n` compatibility module

## Validation

`npm test` runs deterministic API, worker, parsing, persistence, and optimizer regressions. All provider calls in these tests are mocked.

The pull-request workflow builds the exact candidate and an immutable baseline, then runs Playwright on a fresh GitHub-hosted runner. It checks desktop/mobile flows, keyboard access, reduced motion, cancellation/errors/recovery, and paired 10,000-example / 1,000-run fixtures. Reports include screenshots, traces, revision IDs, and timing/DOM metrics. See [browser acceptance methodology](tests/e2e/README.md).

For a normal development environment with Playwright Chromium installed:

```bash
npm run build
npm run test:e2e
npm run test:benchmark
```

Synthetic timings are not a human usability study. Mocks prove workflow behavior, not the quality of a real model or arbiter.

## Limits

- Current Chrome, Firefox, or Safari with IndexedDB, Web Workers, and modern JavaScript is required; automated browser checks use Chromium
- API responses are not streamed. Usage is counted when returned by the provider; cancelled or failed requests may incur charges without returning usage
- Token budgets are checked between iterations, so a single iteration can exceed the remaining budget
- Newest-first history still reads/sorts run metadata because schema version 1 has no task/date index. Dataset import/export and run preparation still process complete datasets; bounded visible pages do not make every operation constant-memory
- Browser storage is local and may be cleared by the browser. Export important results and datasets

See [CHANGELOG.md](CHANGELOG.md) for release changes.
