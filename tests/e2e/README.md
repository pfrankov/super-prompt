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
- Keyboard-reachable model dialog, focus containment and restoration, native More
  menu route links, Enter navigation, Escape dismissal/return focus,
  reduced-motion behavior, and document width bounds
- Synthetic 10,000-example / 1,000-run / 12,000-candidate fixture, identical on both builds
- Candidate dataset page is 10 rows, history is 20 rows, candidates are lazy and
  capped at eight; paging updates the expected records
- IndexedDB instrumentation rejects eager full reads of example bodies and
  candidates before history disclosure
- Guided prompt → model setup → run → proposed revision flow, with one dominant
  next action and setup dismissal preserving the brief
- Exact added/removed/unchanged diff counts and non-color accessibility labels
  behind the Original wording disclosure; the proposed prompt is the default view
- Use this revision and Undo last apply preserve exact text, including Unicode
  and blank lines; undo survives same-tab reload and is invalidated by later edits
- A 5,000-line complete replacement keeps diff rendering within 200 chunks and
  32,000 characters per page, explicitly reports limited matching, replaces
  pages rather than appending them, and preserves full export/apply/undo content

## Evidence and interpretation

The job retains an HTML report, JUnit results, successful workflow screenshots,
failure screenshots/video/traces, revision metadata, and `benchmark-comparison.json`.
Named PNGs cover new task, prompt editor, model setup, running feedback, completed
guided revision, expanded diff, the More menu, errors, and mobile states. The small two-line
revision fixture is synthetic visual/interaction evidence; it is not a real
provider evaluation or an assertion that the proposal is objectively better.
The JSON contains three interleaved baseline/candidate samples, raw FCP,
DOMContentLoaded, interaction durations, long-task data, DOM counts, optional
JavaScript heap bytes, and medians.
Each variant uses a fresh context on the same runner/browser/viewport and the
same fixture; fixture insertion is outside the measurements. HTTP responses are
`no-store`. Browser/OS disk and CPU warmup are not eliminated; alternating order
reduces but does not remove that variance.

The same first dataset textarea (`item-00000`) receives the same edited text in
both builds. Its input event starts two measurements: a two-requestAnimationFrame
rendering-opportunity proxy and the actual IndexedDB write transaction's
`complete` event. A subsequent direct read verifies the exact persisted value.
The latter is browser-level commit evidence, not a physical-disk flush or proof
of crash durability. Input timestamps exclude Playwright's locator/focus delay;
the two-frame proxy is not a presentation timestamp or INP.

History scroll measurements reset the viewport to the top, then request the same
instant 500px scroll. Raw requested/observed distances, scroll-event delay, and
two-frame rendering-opportunity latency are recorded. Insufficient range is
reported explicitly; unmatched distances are excluded from the scroll median.
This is a programmatic scroll over different recorded DOM sizes, not a wheel
gesture or a claim about human scrolling. Dataset/history snapshots also record
`performance.memory.usedJSHeapSize` when exposed, otherwise null. This optional,
non-standard metric can be coarse or shared; garbage collection is uncontrolled,
instrumentation allocations are included, and it measures neither peak usage
nor total process/app memory. No relative timing or memory budget is asserted.

`workflow-comparison.json` separately measures the fresh demo path on both
revisions: configuration steps, explicit scripted clicks, observed auto-scroll
events, time to running feedback and completion, and whether input/result
headings share the initial viewport. It records the baseline's Settings flow
and the candidate's workspace dialog flow. The guided candidate has no separate
result panel before a revision exists, so its pre-run result-heading metric is
null and workflow-navigation visibility is recorded instead. Scroll events are
not equated with intentional human scrolling.

These are scripted synthetic measurements, not a human usability study or real
model quality evaluation. A fast fixture run does not establish prompt quality.
Timing has no predeclared relative-speed pass gate: CI runners vary. Structural
bounded-rendering and functional assertions are hard gates. `historyReadyMs`
ends when the expected complete visible page has rendered, so baseline history
includes its 1,000 eager run cards while candidate history includes its first 20.
The candidate's More menu is opened before starting that route-activation timer;
the measured action then clicks its History link, while baseline clicks its
History tab. The raw sample records this control difference explicitly.
The report states both counts rather than treating these as identical DOM work.

`npm run test:e2e` runs the functional suite against an existing production build.
`npm run test:benchmark` runs the candidate-only fixture unless
`E2E_BASELINE_URL=http://127.0.0.1:4174` and `.benchmark-baseline/dist` are available.
The hosted job runs both suites in one report. Do not claim browser acceptance
until that job passes for the exact final commit.
