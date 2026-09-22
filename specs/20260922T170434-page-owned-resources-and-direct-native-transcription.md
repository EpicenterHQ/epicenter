# Ready application contexts and direct native transcription

**Date**: 2026-09-22
**Status**: In Progress
**Owner**: Braden

Scope note: this product integration is separate from the completed API-only
[blob implementation](../docs/reports/20260922-store-owned-blobs-implementation.md).
That assignment does not authorize Whispering migration. Its store-owned blob
contract replaces older independent-blob assumptions here.

The agreed user workflow and target callsites are in
[Whispering recording and transcription](20260922-whispering-recording-workflow.md).
Stop saves audio and the recording row locally, then automatically starts
transcription by default. Manual retry uses the saved audio. Explicit remote
blob upload and transformations are outside this first workflow; existing upload
outcome repairs remain in the broader integration assignment.

Use “document” for store data in architecture explanations and
“browser/WebView lifetime” for reload and access ownership. The older “page”
wording below denotes that lifetime, not a new SDK object. An application can
open several stores, each with one Yjs data document. An overlay can message the
main interface without opening another store.

## One sentence

The working layout opens independent handles, ready UI branches publish them
through typed get/set contexts, and operations retain explicit dependencies and
completed work for their lifetime.

## Current state and destination

The earlier implementation task stopped partway through the native-transcription
wave. The dirty checkout contains independent constructors, shared boot changes,
native recording generation fencing, and a direct runtime transcriber. The native
clean break is complete; the old native HTTP bridge has been removed. See the
[verification report](../docs/reports/20260922-runtime-transcriber-clean-break.md).
Catalog reads still acquire clients. Treat the execution notes below as reported
evidence, not proof that the current
checkout passes every check.

Whispering still opens Personal before constructing its recorder when signed in.
Its ready shell distributes a broad App with optional `personal` and a selected
`library` alias. The next slice replaces those dependencies with independent
readiness and typed contexts, as recorded in
[ADR-0392](../docs/adr/0392-product-boundaries-provide-required-resource-handles.md).

The destination is page-owned roots, operation-owned temporary work, direct native
transcription, inert saved-connection reads, and explicit application outcomes.
Start by completing Whispering's readiness/context boundary while preserving
the existing departure fences. Then finish affected shared consumers, the native
and catalog paths, and recording outcomes. Completion requires real caller and
runtime evidence; passing library tests alone is insufficient.

This plan is implementation scaffolding. The accompanying `.handoff.md` is the
copyable assignment for a subsequent implementation session. The context design
was reviewed by two independent readers. A premature context implementation was
fully undone at the user's request: four files matched their pre-edit snapshot
byte-for-byte, and two newly added components were removed. This revision leaves
the earlier task's implementation in place and changes documentation only.

Before that attempted context edit, `bun run --cwd apps/whispering typecheck`
passed for both targets with zero errors and warnings. No context implementation
or new runtime acceptance is claimed. Capture a new execution baseline and rerun
the checks; the workspace already contains unrelated dirty work.

## Decisions

The user chose this direction in the design discussion. ADR formal statuses are
unchanged; the implementation assignment does not authorize status promotion.

| Decision | Record | Consequence |
| --- | --- | --- |
| Constructors and destinations | [0423](../docs/adr/0423-app-resources-open-as-independent-handles.md) | Stores own blobs; no aggregate App API or implicit upload source |
| Ready handles in typed Svelte context | [0392](../docs/adr/0392-product-boundaries-provide-required-resource-handles.md) | `getLocal`/`setLocal`, `getPersonal`/`setPersonal`, `getStore`/`setStore`; no eager live exports or optional personal consumers |
| Page-owned roots and reload-only replacement | [0415](../docs/adr/0415-runtime-replacement-ends-application-sessions.md), [0380](../docs/adr/0380-resource-handles-own-terminal-shutdown.md) | Remove redundant product teardown after proving host ownership |
| Explicit resources in operations | [0373](../docs/adr/0373-product-operations-receive-their-resource-handles-explicitly.md) | Do not pass the whole app merely to reach one resource |
| Direct native transcription | [0424](../docs/adr/0424-runtime-transcription-calls-the-host-directly.md) | Delete native synthetic HTTP; retain network SDK clients and streams |
| Metadata reads separate from acquired access | [0365](../docs/adr/0365-ai-owns-inference-access-and-applications-own-workflow-selection.md) | Listing connections creates no clients; revocation still applies |
| Results retain completed work | [0396](../docs/adr/0396-transcription-operations-preserve-destinations-and-results.md) | Saved bytes, URLs, and text survive later failures in returned outcomes |
| Transcript content separate from attempt state | [0425](../docs/adr/0425-a-transcript-is-separate-from-its-latest-attempt.md) | New transcript is null; retry failure retains prior text |

Here page means a browser document or a loaded WebView document. It does not mean
a Yjs/data document. A page captures one account context, possibly signed out,
but can open multiple Local and Personal stores and blob namespaces. There is no
SDK library primitive. Rename Whispering's selected `library` handle to `store`;
use `local` and `personal` for concrete stores. Preserve durable storage keys.
Changing an already-open view does not inherently require reload. Do not add
a global one-account restriction to the resource SDK.

## Starting evidence

- `packages/app/{README.md,ARCHITECTURE.md,package.json}` describe implemented
  constructors and exports. Preserve current-behavior accuracy while changes land.
- `apps/whispering/src/lib/whispering/{resources.ts,ui-session.ts,app.ts}` own
  current mixed-readiness acquisition, optional Personal, and UI workflows.
  `context.ts` and `(app)/_components/WhisperingShell.svelte` already establish
  a ready context, but still publish the broad App facade.
- `packages/app-shell/src/boot-screens/app-boot.svelte` already captures an account
  once and replaces the document on identity change. The interrupted task changed
  `stop()` to abort product work. Recorder close remains attached to that signal;
  preserve its protection while completing ownership verification.
- `apps/whispering/src/routes/(app)/+layout.svelte` already fully navigates on
  Local/Personal selection. Do not count existing reload behavior as new work.
- `apps/epicenter/src-tauri/src/lib.rs` releases document-owned capture on page-load
  start and window destruction. `recorder/sessions.rs` fences stale sessions.
  These paths establish a starting point, not proof for every native capability.
- `apps/epicenter/src/server.ts` and `src-tauri/src/sqlite.rs` own native SQL
  lifetime-socket release and statement work. Trace actual disconnect callers.
- `packages/app/src/{ai.ts,runtime-transcriber.ts,native-ai.ts,inference.ts,endpoint-transport.ts}` contain
  the new direct resource, surviving runtime bridge, and network request owner. `src-tauri/src/transcription/mod.rs`
  owns `list_inference_models` and `transcribe_audio_bytes`.
- `packages/app/src/connection-catalog.ts` materializes clients on reads. The picker
  in `packages/app-shell/src/inference-picker/catalog.svelte.ts` discards runtime
  discovery errors. Preserve failure separately from absence and an empty list.
- `apps/whispering/src/lib/operations/{recording.svelte.ts,push-to-talk.ts,
  save-audio-recording.ts,upload-recording.ts,pipeline.ts,transcription-history.ts}`
  and `whispering/recordings.ts` contain the remaining outcome work. Trace manual
  controls, upload button, command dispatch, VAD/import, and layout callers.
- `apps/vocab/src/lib/resources.ts` and its dictation/chat consumers provide a
  second real application. Trace other shared-boot consumers before changing contracts.

The earlier `docs/reports/20260922-resource-api-integration-handoff.md` is evidence
for outstanding caller work. Its aggregate product rollback expectations do not
override the page-root direction here. Preserve its concrete partial-success
findings without restoring its older lifetime assumptions.

## Before and after at actual boundaries

These after sketches describe intent, not exports already available.

### Whispering startup

Current excerpt from `whispering/resources.ts:26`:

```ts
const personal = account ? await openPersonal(whisperingDefinition, { account }) : undefined;
```

Target: local startup opens Local and LocalBlobs, then constructs the recorder.
A separate account boundary has a required Account and opens Personal. Its ready
child initializes `setPersonal(fromData(personal))` synchronously. Do not put the
local working shell behind the Personal await branch. An async composition helper
is allowed; call it from the working layout, never from an eager module export.

Use context for shared handles throughout the UI, with get/set names only.
Keep props for the ready shell's inputs and component-specific values/callbacks.
Do not introduce `use*`/`provide*` aliases, a generic provider registry, or a
context per constructor without a real consumer. The context module is inert.

### Dictionary editor

Current excerpt from `settings/dictation/+page.svelte:25`:

```ts
const dictionary = $derived(app.personal?.kv.get('dictionary') ?? []);
```

Target inside a personal-ready editor:

```ts
const personal = getPersonal();
const dictionary = $derived(personal.kv.get('dictionary') ?? []);
```

The sign-in/loading/failure boundary moves outside the editor. Local Polish
controls remain usable outside that boundary. An unset dictionary keeps its
value default; absent Personal is no longer represented inside the editor.

### Recording list

Current excerpt from `recordings/+page.svelte:249`:

```ts
const recordings = $derived(sortedRecordings(app.library));
```

Target inside the ready recording UI:

```ts
const store = getStore();
const recordings = $derived(sortedRecordings(store));
```

The mounted owner chooses the concrete destination. Recording operations retain
that store across awaits. Rename source identifiers, not persisted keys or data.

### Required behavior across readiness boundaries

- Local/Personal selection and account availability are separate dimensions.
  Signed-in local recording can still use personal settings and hosted inference.
- Personal becoming ready must not replace an active local recorder or reset
  its query/workflow state. Personal-only feature branches can mount separately.
- Personal acquisition failure must not silently replace configured account
  inputs with defaults. A dependent operation waits or reports unavailability;
  recording still saves audio. Signed-out built-in behavior remains available.
- Context getters run during component initialization. Ordinary operations receive
  explicit dependencies and values. `fromData` supplies reactivity, not context.
- Layout context does not cancel async work or close resources. Retain departure
  fencing, late-result suppression, and host cleanup. Do not retry root acquisition
  on component remount while the old browser/WebView still owns its roots.

### Native transcription

The surviving `native-ai.ts` constructs `Request`, decodes `formData()`, calls
`invoke('transcribe_audio_bytes', ...)`, and returns `Response.json(...)` to the SDK.

The new `runtime-transcriber.ts` already provides the direct path. Verify and
finish its consumers before deleting the bridge. Target callsite:

```ts
const runtime = await openRuntimeTranscriber();
const result = runtime
  ? await runtime.transcribe({ audio, model, language, prompt }, { signal })
  : /* explicit unavailable outcome chosen by the application */ null;
```

Do not preserve the old native fake URL as the new runtime's identity. Do not
rewrite persisted selections without authorization. A stale selection can be
explicitly unavailable rather than silently remapped.

### Saved connection discovery

Current `catalog.svelte.ts` gets `connection.client`, discovers models, and uses
`record.client !== connection.client` to reject a stale metadata update.

Target:

```ts
const record = connections.get(id); // metadata only
const acquired = await connections.open(id); // illustrative acquisition API
// Discover through acquired access; publish only for the captured entry/revision.
// Temporary access closes when discovery ends; settings reads acquire nothing.
```

The catalog retains invalidation for destination/key edits and deletion. An
active-access registry may replace the cache; count that retained complexity.

## Execution waves and review checkpoints

Every checkpoint reviews the cumulative implementation and remaining plan.
Use `adversarial-review` for two independent read-only reviewers where available.
Give them raw code, actual callers, the baseline, and the decisions. Resolve
findings, update this plan, and continue. A review checkpoint is not completion
of the assignment. Do not launch implementation work that depends on an unresolved
ownership verdict. Report reviewer availability limits without pretending a local
pass was independent.

### Wave 0: Capture evidence and reconstruct ownership

- [ ] Capture `git status --short --branch`, `git diff --name-status`, untracked
  paths and contents, and both working-tree and staged binary diffs outside the repo.
- [ ] Read relevant AGENTS files, skills, resource READMEs, and the decision records.
  Inspect current code rather than treating older specs as implementation truth.
- [ ] Map page roots, temporary handles, background work, native sessions, and
  every shared-boot consumer. Re-establish focused baseline checks.
- [ ] Adversarial review the proposed ownership map before deleting teardown.

### Wave 1: Prove page ownership in Whispering

- [ ] Keep account context fixed for the document. Keep multiple stores legal.
- [ ] Complete local readiness independently of Personal, remote blobs, and
  inference/catalog failures. Personal destinations still require Personal.
- [ ] Publish ready handles from the appropriate mounted shells through typed
  get/set contexts. Keep the context module inert and adapt stores with `fromData`.
- [ ] Migrate dictionary/instruction editors, recipes, recording lists, settings,
  recorder controls, and remaining consumers. Remove optional-personal no-op
  writes and the broad resource facade once callers use concrete dependencies.
- [ ] Preserve built-in recipes, signed-in Local behavior, and the fixed selected
  recording destination. Rename handle vocabulary without rewriting durable keys.
- [ ] Test missing-provider failure, readiness gating, late resolution after
  retirement, personal failure during local use, and no duplicate acquisition on
  ordinary route changes. Review this boundary before migrating dependent work.
- [ ] Keep required opening failure explicit at its feature boundary.
  Required acquisition failure requires reload to retry. Request failures can
  retry through an existing usable handle.
- [ ] Move browser auth departure work to a resource-free destination where
  appropriate. Preserve credential clearing and bounded revocation. Preserve
  desktop credential-write-before-restart ordering and cancellation policy.
- [ ] Prove navigation failure/stall and auth rejection cannot leave active
  capture or privileged work behind an inert page. Until proven, retain the
  minimal admission fence and stopping that performs this job.
- [ ] Prove native capture/session retirement, stale IPC refusal, and SQL owner
  release on actual page replacement. Noninterruptible compute remains host-owned.
- [ ] Switch the real bootstrap consumers away from aggregate product close.
  Verify the replacement path before deleting handle arrays, aggregate close
  promises, rollback loops, and sibling-signal fan-in.
- [ ] Adversarial review this vertical slice before propagating it.

### Wave 2: Integrate shared boot and affected applications

- [ ] Migrate every consumer affected by the shared boot contract, including Vocab.
  Preserve app-specific operations and data behavior; do not redesign unrelated apps.
- [ ] Keep explicit cleanup for captures, VAD, playback URLs, temporary previews,
  response bodies, and subscriptions that end before their page.
- [ ] Treat history restoration and stale desktop pages as ownership events;
  a retired page cannot resume old access or automatically retarget an account.
- [ ] Adversarial review cumulative page/host ownership and resolve findings.

### Wave 3: Replace the native HTTP bridge

- [x] Implement the narrow runtime transcriber over validated IPC. Preserve exact
  model selection, empty audio, typed expected failures, and host work settlement.
- [ ] Update model discovery, workflow selection, Whispering and Vocab callers,
  and the picker without offering native chat or fallback to another source.
- [ ] Keep hosted/custom network SDK clients and their streaming/auth guarantees.
- [x] Stop importing the native SDK bridge. Prove the direct path, then delete
  the old bridge/export, synthetic origin, and native HTTP-only tests.
- [ ] Adversarial review the direct path and network non-regressions.

### Wave 4: Separate connection descriptions from live access

- [ ] Make reads/subscriptions metadata-only. Add explicit acquired access with
  an owner and captured revision. Keep hidden desktop keys in the broker.
- [ ] Preserve immediate retirement on credential/destination edits, deletion,
  and catalog closure. Rename/model-list/order changes need not revoke access.
- [ ] Migrate picker discovery and operations; preserve runtime discovery errors.
- [ ] Verify revocation before removing client-bearing snapshots and the old cache.
- [ ] Adversarial review whether machinery was deleted or moved; keep the actual
  guarantees even if an active-access registry remains necessary.

### Wave 5: Finish application outcomes and transcript semantics

- [ ] Prove the agreed default: Stop commits local audio, persists its recording
  row, then automatically starts transcription. Show the saved recording while
  transcription runs. A failed attempt permits retry from the same audio.
- [ ] Check the ideal callsites against actual APIs before implementation. Preserve
  the distinction between an immediate row mutation and confirmed persistence.

- [ ] Propagate recording start/stop/cancel Results and meaningful no-ops through
  manual controls, push-to-talk, commands, imports, and VAD. Preserve capture identity.
- [ ] If local publication completes while the caller still exists, retain the
  blob ID even when its workflow retired; do not create rows through the retired
  owner. Actual page destruction may leave unreferenced bytes without a returned
  receipt. Ordinary `RowCreateFailed` already retains the blob ID.
- [ ] Consume `ReferenceNotSaved` at upload presentation. Recover the row reference
  without another upload. Do not claim a recovery UI merely because the URL exists.
- [ ] Preserve usable text after failed history writes and previous text after
  failed retranscription. Initialize new transcripts to null and attempts to
  not-started. Serialize overlapping attempts or fence stale publication by
  attempt identity. Audit all nullable consumers and persisted status spellings.
- [ ] Keep one final presentation owner. Preserve product notices and recovery
  actions deliberately; no giant action runner or catch-all retryable errors.
- [ ] Adversarial review cumulative workflow ownership and partial-success paths.

### Wave 6: Verify, remove obsolete paths, and finish documentation

- [ ] Complete each replacement as build, switch callers, prove, then remove.
  Temporary unused old code is a verification boundary, not a compatibility feature.
- [ ] Run local `post-implementation-review` after repairs. Broaden checks only
  for changed behavior, failures, or unresolved risks.
- [ ] Update current READMEs, examples, and decision implementation notes. Keep
  formal ADR statuses unchanged. Delete this spent plan and its handoff when the
  implementation is complete; update spec history under repository conventions.

## Evidence required for completion

| Boundary | Evidence |
| --- | --- |
| Page startup | Failure after partial root acquisition cannot trigger same-document re-acquisition; reload recovers |
| Ready contexts | Account-only consumers receive required `getPersonal()`; context is set during initialization; misplaced consumers fail visibly |
| Independent readiness | Signed-in Local recording survives delayed/failed Personal opening; ready Personal does not remount active Local work |
| Optional features | Broken remote blobs, catalog, or discovery leaves local recording/playback and document use available |
| Departure | Real reload and auth failure/stall; no old capture behind a stopped screen; no successor account in old handles |
| Native ownership | Late old-session commands cannot affect new capture; SQL release is safe; admitted compute settles safely |
| Inference | Browser absence, empty models, broken binding, exact model, empty audio, malformed result, cancellation; network streams still work |
| Catalog | Metadata reads acquire no clients; access revisions and hidden-key isolation survive edits/deletion |
| Application outcomes | Blob ID, remote URL, and text retained after later failures; delayed release cannot stop another capture |
| Transcript | Null versus empty success; prior text survives retry failure; stale attempts cannot overwrite newer output; interrupted attempts do not pretend to be live |
| Presentation | Actual UI/command callers own one presentation and any claimed recovery |

Select commands after inspecting current scripts. Likely commands include:

```sh
bun run --cwd packages/app test
bun run --cwd packages/app typecheck
bun run --cwd apps/whispering typecheck
bun run --cwd apps/vocab typecheck
bun run --cwd packages/app smoke:recording
bun scripts/check-doc-hygiene.ts
git diff --check
```

Run focused operation tests from their package working directory, shared-boot and
account-transport checks, and relevant Rust/native integration checks. Existing
test filenames can move during the clean break. Synthetic browser capture and
mocked IPC do not establish physical microphone or installed desktop acceptance.
Report exact blockers and evidence obtained; do not reuse earlier test counts.

## Boundaries and unresolved evidence

No commits, staging, resets, branch deletion, deployment, or data migration are
authorized by this plan. Preserve unrelated dirty and untracked work, especially
the store implementation. Existing empty transcripts and attempt statuses need
an explicit persisted-data compatibility assessment before any migration runs.

Keep explicit local upload sources, differing source/destination namespaces,
independent remote copies, and account-bound remote access. Keep browser secret
memory and desktop keychain behavior truthful; this work does not redesign secrets.
Reload is not a save barrier and does not undo a remote request already committed.

Native shortcut replacement, transformations, new storage engines, cross-resource
transactions, and durable orphan-recovery queues are outside this assignment.
No generic resource container, provider registry, universal SDK wrapper, or
page-global current-account lookup is needed to execute these waves.

The context design review used DeepWiki for `sveltejs/svelte` and `sveltejs/kit`,
then checked official docs and installed source. Sources and the settled rule
are in ADR-0392. The earlier idea of a module-level exported `app` promise was
rejected because acquisition belongs to the admitted working lifetime. Props-only
distribution was rejected for shared handles; component-specific props remain.

Evidence may change implementation choices. Bring back only a fact that changes
the accepted product promise or requires a prohibited side effect; resolve routine
API spelling and code organization in the implementation and its reviews.


## Execution evidence, 2026-09-22

Execution baseline: `/tmp/epicenter-execution-baseline-20260922T174034/`.
Baseline toolkit tests: 768 pass; toolkit, Whispering browser/host, and Vocab typechecks pass.
Wave 0 independent reviewers agreed on a separate departure signal and identified
late first native registration as a missing host fence. Wave 1 adds a host
WebView generation and proves stale admission refusal across actual reload.
The physical microphone probe failed before capture with CoreAudio OSStatus
560947818; no physical capture acceptance is claimed.

Wave 1 reviews retained the ownership design and required cancellation on
completion/discovery, visible optional failure, and deferred resolution of a
selection captured while inference opens. Those repairs are implemented.
Chromium and WebKit boot smoke passes, 34 native recorder unit tests pass,
39 shared-shell tests pass, and 24 transcription/completion tests pass.
The native restart probe now exercises SQLite without explicit close, alongside
IndexedDB markers: 20 restarts/reopens preserve committed markers. Shutdown
logs contain SQLite dispatcher cleanup failures, requiring attribution before
claiming clean shutdown. No production or user data was used.

Remaining review obligation: remove coupled optional inference readiness during
native/catalog waves; preserve separate pending, absent, failed, and empty states.
Fresh reviewer allocation hit the runtime thread limit at wave 1; one fresh
reviewer and one returning read-only reviewer were used. Subsequent checkpoints
reuse available independent read-only reviewers and report this limitation.
