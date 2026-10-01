# Application runtime composition

**Date:** 2026-09-09
**Status:** In Progress
**Owner:** Codex

## Current opening boundary: 2026-09-18

[ADR-0407](../docs/adr/0407-app-owns-the-declaration-and-data-engine.md) completes
the declaration/opening split: `defineApp` is platform-free, `openApp` owns the
App lifetime, and `openData` borrows caller-owned SQLite. Public runtime/AI
overrides and historical generation helpers are removed; old bytes and server
HTTP 409 protection remain. Earlier opening examples and generation-helper
checkpoints below are historical evidence, not remaining API work. Broader
acceptance and product outcomes in this plan remain separate.

## One sentence

One application declaration selects compatible storage and recording while the
opened App owns their identity, readiness, and shutdown.

## Active execution path

Implementation and browser workflow acceptance are complete. Continue with
[remaining acceptance evidence](#remaining-acceptance-evidence): native-host
recording/read/play/reopen and active-capture reload recovery. The execution
checkpoint below records delivered changes and diagnostics. Earlier examples
show the task-start migration, not APIs still awaiting implementation.

## Outcome

Implement the runtime decision in [ADR-0376](../docs/adr/0376-application-authors-declare-data-and-the-opened-app-owns-resources.md).
Keep ordinary declarations unchanged. Replace Whispering's curried declaration
with an explicit runtime value and independent AI binding. Move saved-recording
integration into App while retaining portable microphone/VAD APIs in recorder.

Done means the old declaration APIs and saved-recording exports are gone,
both build targets select compatible implementations, and recordings can be
read through the App that saved them. Native recovery, storage locations, AI
settings namespaces, and lifecycle guarantees must survive.

This is implementation scaffolding. Delete it when its checkpoints are complete.
Do not change ADR acceptance status as an implementation bookkeeping step.

## Task-start evidence

| Current file | Behavior that controls this change |
| --- | --- |
| `packages/app/src/index.ts` | Three declaration paths: `defineApplication`, `createEpicenter`, and `bindApplication` |
| `packages/app/src/open.ts` | Captures account identity and owns resource readiness and close |
| `packages/app/src/platform/*.ts` | Selects SQLite and secrets by build condition |
| `packages/app/src/browser.ts` | Supplies browser blobs and default AI configuration |
| `packages/recorder/src/browser.ts` | Creates its own browser blob store when capture starts |
| `packages/recorder/src/desktop.ts` | Publishes and recovers through Epicenter native commands |
| `packages/blobs/src/webview.ts` | Reads native blobs through host HTTP routes |
| `apps/whispering/src/lib/runtime.ts` | Sole current `bindApplication` caller |
| `apps/vocab/src/lib/state/dictation.svelte.ts` | Uses transient VAD independently of saved recordings |

These are inspected working-tree facts, not claims about HEAD. The checkout
already contains substantial concurrent changes. Capture task-start content and
diagnostic results before implementation, and preserve unrelated edits.

## Target callers

The following examples translate current callers. Proposed runtime exports do
not exist yet.

### Whispering

Current `apps/whispering/src/lib/runtime.ts` binds platform imports:

```ts
export const defineApplication = bindApplication({ ai, sqlite, blobs: appBlobs, recording });
```

Its `bootstrap.ts` then supplies identity and definition. Replace both steps
with this declaration in bootstrap:

```ts
import { defineApplication } from '@epicenter/app';
import { runtime } from '#platform/runtime';
import { ai } from '#platform/ai';

const application = defineApplication({
  appId: APPS.WHISPERING.id,
  definition: whisperingDefinition,
  runtime,
  ai,
});
```

The host leaf selects `epicenterHost` from `@epicenter/app/epicenter-host`.
The browser leaf selects a complete browser runtime exported from the existing
`@epicenter/app/browser` subpath. Name that value `browser`. Preserve existing
AI leaves, including Whispering's native configured HTTP transport.

### Honeycrisp and Vocab

The current declaration arguments remain unchanged:

```ts
// apps/honeycrisp/src/lib/application.ts
defineApplication({
  appId: APPS.HONEYCRISP.id,
  settingsKey: 'honeycrisp',
  definition: honeycrispDefinition,
});

// apps/vocab/src/lib/application.ts
defineApplication({
  appId: APPS.VOCAB.id,
  settingsKey: 'vocab',
  definition: vocabDefinition,
});
```

Preserve their current opening, auth, and departure behavior. In particular,
do not switch these applications from browser blobs to native blobs simply
because their build selects native SQLite and secrets.

## Contract and ownership

`defineApplication` accepts identity, definition, optional `settingsKey`, a
complete optional runtime, and an independent optional AI binding. Omission
uses defaults. An explicit runtime replaces all runtime resources; an explicit
AI binding replaces all AI configuration. Do not deep-merge either value.

The runtime contract supplies SQLite, secrets, blob composition, and recording.
It represents implementation selection, not an opened library or a new cleanup
owner. App binds the selected resources to the captured identity at open time.
Custom runtimes must satisfy the same publication/read contract as built-ins.
Do not claim structural TypeScript types prove runtime compatibility.

The integration retains `openLocal()`, `openPersonal(account)`, and
`openShared(account)` and their captured resource scopes.

Saved-recording contracts and implementations move into `packages/app`.
`@epicenter/app/recorder` exposes the contract without statically importing
native implementations. The recorder root and VAD-assets export stay independent.
Move applicable tests and smoke scripts with their implementation, preserving
host wire-type checks and portable device types without a dependency cycle.

## Execution checkpoints

### 1. Establish the baseline and runtime contract

- [x] Read applicable instructions, current exports, callers, and existing tests.
- [x] Save the task-start diff and relevant file contents outside tracked paths;
  record focused diagnostics before editing.
- [x] Implement one declaration path with explicit default selection, complete
  runtime replacement, and independent AI replacement.
- [x] Keep `openApp` as the lifecycle owner. Avoid eager resource acquisition
  when importing a runtime or declaring an application.
- [x] Add focused checks for default preservation, override semantics, and
  definition type inference. Do not introduce a generic plugin registry.

### 2. Move recording ownership and migrate consumers

- [x] Move saved-recording contract, implementations, and their tests into App.
- [x] Add browser and Epicenter-host runtime values with compatible blob access.
- [x] Update package exports and required dependencies without importing native
  modules into browser entrypoints.
- [x] Migrate Whispering to `#platform/runtime` and retain `#platform/ai`.
- [x] Migrate constructor tests, recording types, generated-binding type checks,
  and other consumers found by repository search.
- [x] Delete `bindApplication`, `createEpicenter`, Whispering's curried module,
  and its replaced SQLite/blob/recording platform leaves. Remove old recorder
  saved-recording exports without compatibility aliases.
- [x] Update package READMEs and current-code references. Preserve VAD consumers.

### 3. Prove behavior and close the plan

- [x] Run focused App and recorder tests, then their browser/host typechecks and
  affected application checks using current package scripts and Bun.
- [x] Build Whispering for browser and host; verify runtime selection and native
  import isolation. Preserve existing tests of platform selection.
- [ ] In each supported runtime and local/account scope, stop a recording and
  read/play the returned ID through that same App. Include reopening persisted
  bytes. A mocked recorder returning an arbitrary ID is not this evidence.
- [ ] Verify native reload recovery and cancellation before storage release.
  Preserve existing tests for pending starts/stops, retained operations,
  immutable identity, and failed cleanup retaining ownership.
- [x] Verify existing AI settings namespaces and native configured HTTP binding.
- [x] Perform a post-implementation review and stale-import sweep. Request a
  focused independent review only if implementation changes reviewed ownership.
- [ ] Update ADR-0376's Unbuilt scope for delivered work, retaining unrelated
  gaps; delete this spec and its active link when complete. The Unbuilt scope is
  updated; retirement awaits the live acceptance checks below.

If native host or account fixtures are unavailable, record the exact missing
evidence and keep this spec active. Passing types does not establish native
publication/read compatibility. Attribute failures against the captured baseline
rather than assuming the current HEAD represents task-start state.

## Execution recommendation

Execute these checkpoints as one coordinated change, with a working browser
and host checkpoint before removing the old exports. Do not split a public
recorder-path move from its storage/capture contract: the shorter import alone
would leave the invalid combination possible. This plan does not require data
migration, authentication redesign, or native audio transport redesign.

## Earlier implementation checkpoint: 2026-09-09

The implementation is in place. `defineApplication` is the only declaration
entrypoint. Complete `browser` and `epicenterHost` runtime values select storage
and recording together; AI remains independent. Defaults preserve build-selected
SQLite/secrets and browser blobs. Browser recording receives the App's exact
local blob store. App's existing shutdown order remains intact.

Saved recording and its lifecycle tests now live in App. Portable stream/VAD
APIs remain in recorder. Whispering selects `#platform/runtime` and retains its
existing AI leaves, including native configured HTTP. Its replaced resource
leaves and curried declaration are deleted. Current documentation is updated.

Task-start content and diagnostics are saved in
`/tmp/runtime-composition-baseline/` (`files.tgz`, `start.diff`, and logs).
Unrelated working changes, including concurrent authentication changes to
Whispering bootstrap, were preserved. That checkpoint left the work unstaged.
The later integration committed runtime composition and all constructor/recording
consumers as `89e2cf28f8`, followed by SDK destinations as `fcdf6bfddc`.

### Verification completed

- App browser/host typechecks, recorder typecheck, and Honeycrisp, Vocab, and
  Whispering application checks passed. Whispering checks cover both targets.
- Whispering browser and host production builds passed.
- All 118 focused App, recorder, declaration, Whispering constructor, and platform
  selection tests passed. Run with explicit `./` paths: Bun's bare
  `packages/app` filter also selects unrelated `packages/app-shell` tests.
- Chromium smoke at `packages/app/scripts/browser-smoke.ts` uses a real opened
  browser App, SQLite worker, IndexedDB, and synthetic microphone. It records,
  reads and decodes through App, checks cancellation and meter cleanup, closes,
  reopens, and compares persisted bytes by SHA-256. This covers the local scope.
- A distinct-store regression test verifies publication uses the supplied blob
  store and leaves the identity-derived browser namespace empty.
- Runtime bundle checks found no native capture or Tauri internals in the
  browser runtime; the host runtime contains native capture and host blob routes.
- `bun packages/blobs/scripts/native-smoke.ts` passed: Bun read seven blobs
  produced by the native metadata/publication fixture. This checks format
  compatibility, not a live recording through App.
- Existing native adapter tests cover recovery, pending work, immutable identity,
  and failed cleanup retaining ownership. Host generated wire-type checks pass.

Baseline App typechecks passed. The initial broad test command had 25 failures.
Stale test authority fixtures returned JSON when the current store requested
canonical generation bytes, causing account bootstrap failure and stranded
claims. The App/recording fixtures now retain uploaded generation bytes and
return them on canonical GET. This restored the lifecycle evidence without
changing production storage behavior. Two unrelated App-shell close tests also
failed in the broad baseline command; the focused explicit-path suite excludes
that package.

`bun scripts/check-doc-hygiene.ts` exited successfully but reported 41
repository-wide Proposed-ADR dependency issues. This is not a clean hygiene
report. It reported no terminal-status spec; ADR acceptance was deliberately
left unchanged as this spec requires.

Independent design review compared the production changes to the task-start
archive and recommended retaining the runtime/App ownership boundary. Its one
accepted coverage finding produced the distinct-store regression test. No
production repair or additional API layer was needed.

### Remaining acceptance evidence

The integration continuation proved authenticated browser capture, App blob
reads/playback, and byte-identical reopen for Local, Personal, and Shared.
The actual Whispering UI also saved raw and polished transcripts with real
inference engines. Native SDK file inference passed a real Wry WebView with
production permissions and CSP. A controllable native microphone was unavailable.
Still required:

1. In the Epicenter host, repeat stop/read/play/reopen in Local, Personal, and Shared
   scopes, using real native capture and host blob routes.
2. Reload a host window with capture active, recover through the reopened App,
   then verify cancellation completes before storage ownership is released.

Unit mocks, typechecks, successful builds, and the native blob-format fixture
do not replace these checks. Keep this spec and its ADR link active until that
evidence exists. ADR-0376 remains Proposed; its unrelated implementation gaps
and acceptance status were preserved.
