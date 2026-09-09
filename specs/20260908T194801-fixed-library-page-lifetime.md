# Give each application page one fixed library

**Date:** 2026-09-08
**Status:** In Progress
**Owner:** The implementing agent owns execution, verification, and integration.

## Outcome

An application document opens one library. Changing libraries closes its UI
producers and App before authentication changes and full document navigation.
[ADR-0369](../docs/adr/0369-an-application-page-owns-one-library-and-changing-it-ends-the-page.md)
records the accepted invariant. The broader local/account clean-break spec
retains import, transfer, and whole-library erasure obligations.

## Implemented shape

Each app's `src/lib/application.ts` reads the plain `authClient.state` once,
opens a concrete App, and constructs its departure owner. The mounted
application route dynamically imports that module. Callback and route-preload
imports do not acquire the library. Svelte adaptation lives in `auth.svelte.ts`
and the UI consumers. The shared opener still receives an explicit Account.

Honeycrisp and Vocab retain account-only startup. Whispering retains local
startup. Account or connection departure starts a fresh document; `/?connect`
is a library-free connection screen. Cancel returns through another full
navigation. Selection actions share one operation and preserve failure controls.

`createDeparture` owns first-request arbitration, preflight, irreversible UI
quiescence, App close, and the selected action. A preflight refusal permits retry;
subsequent failure is terminal. Successful close exposes no recovery action while
sign-out or the native host can still commit. Same-Account credential refusal
preserves the App. Unexpected retirement closes locally without replacement.

The application routes now own their actual UI cleanup. The replaceable
`NotesSession`, `ConversationsSession`, and `RecordingsSession` components and
inert `epicenter.svelte.ts` modules are deleted. `AppBoot` renders a fixed App's
lifetime; its destination selection, keyed replacement, generations, and resume
path are gone. There is no compatibility mode.

Desktop broker sign-out retires its Account only after the host answers. The
host's existing barrier requires application-close acknowledgments and destroys
successfully closed windows. It does not resume an old document.

## Review checkpoints

Task-start HEAD: `3f8e3c1f9de02c5719de750e2df0764a91da02b0`. Auth, inference,
recording, native-close, and documentation work was already active in this
checkout. Initial tracked changes are recorded in
`/tmp/fixed-library-page-baseline.diff`; displaced working files were copied to
`/tmp/fixed-page-displaced` before deletion. These temporary files are local
execution evidence, not durable project documentation.

Independent design review accepted plain TypeScript composition before Svelte.
The first implementation review found two defects: recovery controls during
pending auth mutation, and retirement observation in a library-free connection
screen. Both were corrected. Native-listener errors remain visible.

The cumulative review found a reachable producer-lifetime defect during
Whispering retirement. UI disposal now closes recording admission, awaits
admitted startup/finalization/pipeline work, releases VAD, and then disposes
listeners and domains before App close. Focused review found that repair
addresses the blocker. Manual capture remains App-owned; a reload alone is not
capture shutdown.

## Verification evidence

- Full-workspace `bun typecheck` passed after implementation and producer repairs.
- Before committing, an isolated checkout of the staged tree passed every
  workspace typecheck and the scripts typecheck, 25 departure/broker tests,
  9 recording-close tests, and the shared Chromium/WebKit browser smoke.
  Mixed inference and auth cleanup remained outside the staged change.
- Departure, desktop close, auth lifetime, broker, and host authority: 68 tests,
  241 assertions passed.
- App ownership/close: 22 tests, 115 assertions passed.
- Vocab dictation: 3 tests, 9 assertions passed.
- Whispering recording-close: 9 tests, 27 assertions passed; recording workflow:
  8 tests, 32 assertions passed in a separate process.
- Native Rust application-close tests: 4 passed.
- `bun packages/app-shell/smoke/app-boot.browser.mjs`: Chromium and WebKit passed
  local/account departure, preflight refusal, delayed producer and durable
  commit, full connection navigation, cancellation, and selection-write failure
  followed by retry. The fixture uses real Svelte and the document owner.
- `bun apps/honeycrisp/smoke/page-departure.browser.mjs` exercises the actual
  notes UI with disposable browser contexts and intercepted authority replies.
  Chromium and WebKit have proved final-edit persistence through full sign-out
  and reopening. A repeat WebKit run timed out looking for the reopened note;
  subsequent successful repetitions and a final Chromium/WebKit run with API
  tracing do not yet explain that failure. The smoke runner now has bounded
  waits and prints the failing page before releasing its browser.
- Fresh Honeycrisp callback documents imported no application module and opened
  no database in Chromium/WebKit. Vocab signed-out startup opened no database.
- Whispering plain-browser startup reaches the native-only `os.tauri.ts`
  plugin call before rendering. That source is unchanged from task-start HEAD;
  actual native startup/departure needs its host environment.
- `git diff --check` passed. Auth skill discovery validation passed.
- Doc hygiene reports 34 findings: 31 reproduce against the task-start baseline;
  the other three concern concurrent ADRs 0359, 0363, and 0370. None concern this
  spec or ADR-0369. Do not accept unrelated ADRs to make this check green.

## Remaining acceptance work

- [ ] Resolve or attribute the intermittent real-editor WebKit smoke failure.
- [ ] Exercise actual native all-window departure with disposable libraries,
  including active recording refusal, failed acknowledgment, host replacement
  failure, and reload recovery. Rust and mocked-host tests are not this proof.
- [ ] Verify Whispering local/account startup and within-library navigation in
  the real host; retain the same concrete App across application routes.
- [ ] After acceptance, update ADR implementation metadata, delete this spec,
  and index it in spec history. Keep the broader clean-break spec until its
  separate transfer and erasure obligations are fulfilled.

Whole-library removal remains unavailable. This work adds no cross-tab logout
protocol and does not turn close into a wait for complete remote synchronization.
