# Make Whispering operations use the page-owned App at call time

**Status:** Draft
**Date:** 2026-09-08

Whispering product operations access the document's one App when invoked;
module imports acquire nothing, and the page retains readiness and close ownership.

## Outcome and evidence

Implement the direction in [ADR-0373](../docs/adr/0373-product-operations-read-the-page-owned-app-when-invoked.md).
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

- `specs/20260908T193514-app-ai-capabilities.md`: configured clients,
  explicit inference identity, and runtime binding.
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
