# Browser acceptance evidence

The `Verify prompt workspace` GitHub-hosted job builds the exact PR head and the
immutable baseline `ffef3357decd6ea300b2dd26443dacab4ff5e804`. It serves both only on
runner loopback. There is no preview deployment, live provider traffic, secrets,
customer data, or public preview deployment.
Both route interception and the fixture server's CSP constrain browser traffic.

## Acceptance suite

- Desktop Chromium (1440×1000) and mobile Chromium (390×844, touch, reduced motion)
- Fresh prompt → workspace demo configuration → built-in demo run → completed
  result → A/B comparison → exact JSON export → apply → reload
- Pause, navigate away/back, resume, stop, and reload recovery
- Controlled loopback provider failure, retry after model configuration, slow
  preparation cancellation, and comparison error/close/reopen/retry
- Immediate navigation/reload preserves current prompt; home reopening selects Improve
- Keyboard-reachable model dialog, focus containment and restoration, arrow-key
  tab focus, reduced-motion behavior, document width bounds
- Synthetic 10,000-example / 1,000-run / 12,000-candidate fixture, identical on both builds
- Candidate dataset page is 10 rows, history is 20 rows, candidates are lazy and
  capped at eight; paging updates the expected records
- IndexedDB instrumentation rejects eager full reads of example bodies and
  candidates before history disclosure

## Evidence and interpretation

The job retains an HTML report, JUnit results, successful workflow screenshots,
failure screenshots/video/traces, revision metadata, and `benchmark-comparison.json`.
The JSON contains three interleaved baseline/candidate samples, raw FCP,
DOMContentLoaded, interaction durations, long-task data, DOM counts, and medians.
Each variant uses a fresh context on the same runner/browser/viewport and the
same fixture; fixture insertion is outside the measurements. HTTP responses are
`no-store`. Browser/OS disk and CPU warmup are not eliminated; alternating order
reduces but does not remove that variance.

`workflow-comparison.json` separately measures the fresh demo path on both
revisions: configuration steps, explicit scripted clicks, observed auto-scroll
events, time to running feedback and completion, and whether input/result
headings share the initial viewport. It records the baseline's Settings flow
and the candidate's workspace dialog flow. Scroll events are not equated with
intentional human scrolling.

These are scripted synthetic measurements, not a human usability study or real
model quality evaluation. A fast fixture run does not establish prompt quality.
Timing has no predeclared relative-speed pass gate: CI runners vary. Structural
bounded-rendering and functional assertions are hard gates. `historyReadyMs`
ends when the expected complete visible page has rendered, so baseline history
includes its 1,000 eager run cards while candidate history includes its first 20.
The report states both counts rather than treating these as identical DOM work.

`npm run test:e2e` runs the functional suite against an existing production build.
`npm run test:benchmark` runs the candidate-only fixture unless
`E2E_BASELINE_URL=http://127.0.0.1:4174` and `.benchmark-baseline/dist` are available.
The hosted job runs both suites in one report. Do not claim browser acceptance
until that job passes for the exact final commit.
