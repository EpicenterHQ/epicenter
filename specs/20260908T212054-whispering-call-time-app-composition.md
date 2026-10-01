# Make Whispering operations use the page-owned App at call time

**Status:** In Progress
**Date:** 2026-09-08

## Integration continuation: 2026-09-09

`application.ts` now publishes one mounted opening without acquiring resources
on import. Completion, Polish, Recipe, and saved transcription read the ready
App at invocation. Transcription captures its exact client, model, credentials,
and hints before reading the saved blob. The real browser UI exercises that
workflow in Local, Personal, and Shared, including real inference and reopen.

Recording, imports, and manual/bulk retries share admission and complete-work
draining. Unexpected account replacement stops follow-on inference and output
while admitted audio still saves. A failed save still rejects so the recording
caller retains its source. App retirement suppresses late history and delivery.

The UI session remains because it owns capture subscriptions, query state,
buffered UI producers, and their teardown. Full removal of those remaining
product-object arguments is outside the bounded saved-recording integration.
Native file inference has real WebView proof. Compare the dated microphone
evidence with the saved-BlobId implementation before scheduling new acceptance.
Remaining work is product composition and live-session shutdown, not recovery
of unfinished capture after reload. ADR-0366 makes unfinished capture disposable.

The sections below preserve the original migration scope and earlier evidence.

Whispering product operations access the document's one App when invoked;
module imports acquire nothing, and the page retains readiness and close ownership.

## Outcome and evidence

Implement the direction in [ADR-0373](../docs/adr/0373-product-operations-receive-the-page-owned-app-explicitly.md).
Remove redundant product-object argument threading and context composition without
adding a second application handle, readiness promise, or library selector just
to group methods. Keep factories that own actual sessions, resources, or independent
configuration. Svelte observation remains the final layer.

Current code opens the App during `application.ts` evaluation, protected by the
mounted layout's dynamic import. `WhisperingShell` creates a UI session that mixes
product domains, reactive views, query state, recording workflows, and disposal.
`transcribeAndPersist`, `processRecordingPipeline`, and `runPolish` take that
product object. Importing the current application module from those operations
would bypass the mounted opening boundary.

Done means imports/preloads acquire nothing, one App is published per document,
operation callers no longer pass redundant product objects, and final edits and
recording saves survive the same departure sequence. The actual native-window
acceptance and intermittent WebKit failure remain open until demonstrated or
explained, not merely until unit tests pass.

## Reconcile the active checkout first

At writing, the checkout contains concurrent, uncommitted AI and core API work.
`apps/whispering/src/lib/application.ts` already imports `defineApplication` from
`runtime.ts`; `packages/app/src/index.ts` is acquiring `app.ai`. These observations
are not a claim those changes are integrated or verified. Inspect current code,
HEAD, staged changes, and the related specs before editing shared files.

Related work:

- [AI access boundary](../docs/adr/0365-ai-owns-inference-access-and-applications-own-workflow-selection.md):
  custom clients, application-owned selections, and runtime binding.
- `specs/20260908T204224-explicit-core-reads-and-blob-capabilities.md`:
  explicit observations and nullable remote blobs.
- [Fixed page lifetime](20260908T194801-fixed-library-page-lifetime.md): existing
  departure implementation and remaining acceptance evidence.
- `specs/20260908-ai-client-and-portable-dictation.md`: a separate
  microphone-to-text session. It does not automatically replace saved-audio history.

Do not rebuild concurrent work or commit another task's unrelated changes.
Capability-dependent migrations follow a coherent verified capability checkpoint.
Import-purity work and caller inventory can proceed independently.

## Implementation checkpoints

### 1. Establish import-safe publication

Trace imports from callbacks, recording overlays, route preloads, the app layout,
and operation modules. Define one explicit mounted opening path and one immutable
choice of App. Imported operation modules must not acquire storage or inspect data.

Separate the importable App binding from bootstrap orchestration if needed to
prevent dependency cycles. Prototype the smallest publication mechanism before
spreading it across callers. A missing App must not masquerade as a ready value;
avoid unchecked definite-assignment assertions and broad forwarding proxies.
The concrete TypeScript access surface is a checkpoint, not permission to change
the one-document invariant or silently introduce ambient account selection.

Prove close before/during readiness prevents late consumers, initialization
failure releases resources, duplicate opening cannot select a second library,
and signed-out/connection-only startup retains its existing policy.

### 2. Migrate one complete operation and its callers

Begin with a bounded existing workflow, such as Polish, after its AI dependency
is available. Read the actual inputs rather than substituting framework App for
`WhisperingApp` by cast. Remove redundant App arguments only where the document
fixes that dependency. Keep per-call input, cancellation, and explicit destinations.

Use full member paths. Do not capture App namespaces at module evaluation or
create local namespace aliases in components. Group methods only when the group
helps callers; named exports are valid. An object of methods needs no readiness
or opening API. Freezing it is independent of when its methods read App.

Verify the real UI/shortcut callers and failure behavior before expanding the
pattern to transcription, pipeline, and recipes. Shared packages and explicit
cross-library operations keep explicit capability inputs.

### 3. Move remaining ownership, then remove redundant composition

Inventory every responsibility in `whispering/app.ts`, `ui-session.ts`,
`WhisperingShell.svelte`, the context module, and recording operations. Record
where each subscription, query client, capture session, and pending workflow
starts and stops. Remove the context/product wrapper only once these owners exist.

Current settings, recipes, and recording constructors read or subscribe during
construction. Moving them into a singleton module unchanged is not import-safe.
Separate plain operations from Svelte tracking, and preserve reactive updates.
Keep shared recording state and admission/drain ownership where they are real.

Replace Account uses with actual supplied capabilities when supported. Preserve
native blob addressing, explicit inference identity, account-management actions,
and remote deletion safeguards. Do not infer remote or AI support from sign-in.

### 4. Verify departure and complete the clean break

Keep one departure owner sequencing producer shutdown, buffered edits, admitted
workflow completion, App close, and auth mutation/full navigation. Maintain
voluntary recording refusal and immediate unexpected network retirement. Native
acknowledgment must await closure without waiting for the sign-out action itself.

Run an independent design review after the first complete slice and a cumulative
review before deleting the replaced composition. Delete dead imports, product
argument plumbing, obsolete context, and misleading documentation after verification.
Do not delete resource owners merely because they were previously reached through
context. Update the ADR's implementation evidence; retire this spec into spec
history after all required work is complete. ADR status changes require the user's
explicit instruction, not inferred completion.

## Verification

- Import operation modules and preload routes from callback/connection documents:
  no library, microphone, model, or unintended network acquisition.
- Successful readiness enables consumers once; failed readiness never does.
  Repeated startup and within-app navigation preserve the same concrete App.
- Close during opening prevents late initialization; retained operations cannot
  write after terminal close.
- Exercise migrated operation success, cancellation, failure, missing selections,
  and shared callers. No request falls back to another inference destination.
- Delayed recording startup/finalization/save and final buffered editor writes
  settle before storage releases. Refusal leaves the necessary controls usable.
- Run affected focused tests and full `bun typecheck` on a coherent checkpoint.
  Inspect browser output/imports for accidental native dependencies.
- Re-run shared and real-editor browser smoke checks, attribute the outstanding
  WebKit failure, and exercise the real host with multiple disposable app windows.
  Preserve local/account startup and within-library navigation in Whispering.

Record commands, results, and unproven behavior in this spec during execution.
Do not equate compilation or mocked host tests with native acceptance.

## Execution checkpoint: reconciliation

Task-start HEAD: `2dee4a2cbea98c02f5d22bff7a6a25a9a7929def`.
Concurrent tracked and untracked changes are preserved in
`/tmp/whispering-composition-baseline/` for local attribution. Nothing was staged.
The working tree already supplies AI clients and remote blob capabilities;
those changes remain owned by their existing tasks.

Waves: establish import-safe mounted publication and verify its lifetime; migrate
one complete operation after the capability checkpoint; move remaining resource
ownership and callers; verify shutdown and native acceptance before deletion.
The old composition stays until its replacement meets those checks.

### Publication and text-operation checkpoint

- `application.ts` is inert. The mounted layout calls `openApplication()` once;
  `bootstrap.ts` captures auth and the connect-only policy and opens the App.
  `getApp()` rejects before successful readiness and after actual App close starts.
- Departure preflight does not revoke access. Admitted work can still read the
  App during UI quiescence. `bootstrap.closeApp()` owns terminal revocation.
- Failed readiness releases the concrete App without completing document
  departure, preserving the opening-error screen and retry control. Cleanup
  failures are logged with their cause.
- Polish and Recipe execution read settings and completion capabilities at call
  time. Completion preserves the saved connection/model identity. Its Svelte
  adapter observes KV and AI configuration, then calls the same product resolver.
  The old UI session, context, recording admission, query client, and subscriptions
  remain until their resource replacements and shutdown evidence are complete.

Independent review found and resolved three publication defects: readiness lost
when a preflight later refused, access revoked before admitted work drained, and
failed acquisition cleanup hiding the opening error behind the departure screen.
The reviewer also identified duplicated completion resolution; the Svelte layer
now observes and presents the plain resolver instead of repeating its decision.

Verification so far:

- `bun test` over `application.test.ts`, `completion.test.ts`,
  `run-polish.test.ts`, and `pipeline-auto-upload.test.ts`: 25 passed, 70 assertions.
  Includes in-flight cancellation, exact destination, missing selection, failed
  readiness cleanup, refused departure, and delayed UI drain.
- App/AI prerequisite tests: 42 passed, 200 assertions.
- Existing recording-close, recording-workflow, and departure tests passed in
  separate processes; their logs are in the local baseline directory.
- Whispering browser and host typechecks passed with zero errors/warnings.
- Full `bun typecheck` still fails in concurrent inference-picker test work.
  The task-start run also failed there and in concurrent App tests; the latter
  errors disappeared as that task continued. Do not attribute those repairs here.
- Fresh-process Polish import succeeds without browser globals or network access.
- Shared AppBoot and real Honeycrisp final-editor smokes passed in Chromium and
  WebKit. A successful repetition does not explain the earlier WebKit failure.
- Doc hygiene reports 34 findings. No ADR status was changed.

### Current reconciliation boundary

During execution, `operations/transcribe.ts` changed from the task-start version
and is now being migrated concurrently to App-owned AI clients. Reconcile that
capability checkpoint before editing transcription or removing product ownership.
The active native test process under `/tmp/epicenter-native-review.CPAgjH` was left
untouched. Its older notes reported denied macOS permissions; a fresh check now
reports Accessibility and Screen Recording enabled. A separate disposable native
fixture is being prepared. Native acceptance remains unproven.

Remaining owners before deletion:

| Responsibility | Current owner | Replacement must preserve |
| --- | --- | --- |
| Recording admission and pending work | UI session and recording operations | Stop new work, drain startup/finalization/save, then release capture listeners |
| Recording audio reads and explicit hosting | Recordings domain and blob capabilities | Local-first reads, referenced remote reads, independent byte lifetimes, and settlement of admitted operations; no automatic delivery or backup coordination |
| Settings and recipe subscriptions | Product domains | Readiness-only observation and terminal unsubscribe |
| Query cache | UI session | Mounted query provider and terminal cache clear |
| Buffered edits and UI producers | Layout and Shell | Blur, unmount, settle producers, then close App |

Do not delete this spec or the old composition until the remaining migration,
reactive presentation checks, and actual native shutdown acceptance are complete.
