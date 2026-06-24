# Super-Prompt

A browser-only, GEPA-style reflective prompt optimizer. Define a task (system prompt + rubric), give it a few examples, and the optimizer will iteratively generate prompt mutations, run them through a judge model, and keep the winners — improving your prompt one iteration at a time.

Everything runs client-side: tasks, datasets, and run history live in IndexedDB; the optimizer runs in a Web Worker; no server, no telemetry.

## Quickstart

```bash
pnpm install        # or npm install / yarn
pnpm dev            # http://localhost:5173
pnpm test           # vitest (17 tests)
pnpm build          # production build
pnpm preview        # serve the build locally
```

## Configure a provider

Open **Settings** in the sidebar and fill in:

- **Base URL** — your OpenAI-compatible endpoint (e.g. `https://openrouter.ai/api/v1`).
- **API key** — stored in `localStorage` in plain text. Visible to anyone with access to this browser. (This is a deliberate, user-controlled choice; there is no remote sync.)
- **Target / Judge / Mutator models** — the model that runs the user's prompt, the model that scores it, and the model that proposes new mutations.

The app talks to any OpenAI-compatible chat-completions endpoint. It will not work against providers that don't expose `/chat/completions` with bearer auth.

**CORS note:** Some providers block browser-origin requests. If "Test connection" succeeds but optimization fails, your provider may need to allow your `localhost` origin. There is nothing the app can do about this — it has no backend to proxy through.

## How it works

1. **Task** — a system prompt, a rubric, and optional seed prompts.
2. **Dataset** — a handful of input/expected-output pairs. The optimizer needs at least 2.
3. **Optimize** — start a run. Each iteration:
   - pick a parent candidate (current best),
   - mutate it (LLM call),
   - run both on sampled dataset items,
   - judge pairwise (LLM call),
   - if the child wins, it becomes the new parent.
4. **History** — every run, every candidate, every pairwise verdict is kept.

## Architecture

- **UI:** Svelte 5 (runes) + hand-rolled design tokens in `src/app.css`.
- **Worker:** the optimization loop runs in a Web Worker (`src/worker/`). The main thread only sends start/pause/stop and receives streamed state updates.
- **Storage:** IndexedDB via `idb`. Eight object stores (tasks, datasets, items, runs, candidates, iterations, pairs, settings).
- **i18n:** svelte-i18n with `en` and `ru` locales. All user-visible strings go through `$_(...)`.
- **No network analytics.** No remote logging. The only outbound calls are to your configured provider.

## Browser support

Tested in current Chrome, Firefox, and Safari. Requires IndexedDB, Web Workers, and ES2022. No IE / legacy Edge.

## Known limitations

- DB schema is not versioned. Bumping the schema will invalidate existing data.
- API key is stored in `localStorage` in plain text. (User's explicit choice.)
- No streaming responses yet; tokens-in/out are reported after each call.

See `CHANGELOG.md` for what changed recently.
