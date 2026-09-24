# Complete ready application contexts and the recording handoff

**Date**: 2026-09-22
**Status**: Draft

For the recording ownership collapse, use the newer
[store-relative handoff](20260923T012158-store-relative-recordings.handoff.md).
It replaces this document's upload-reference repair and recording-destination
instructions. This older handoff covers separate broader integration work and
does not expand the newer assignment.

This is a separate, later product integration assignment, following the API-only
implementation. Read [the blob verification report](../docs/reports/20260922-store-owned-blobs-implementation.md)
for the implemented contract; it explicitly defers Whispering migration.

Implement and verify the agreed resource direction in:

```text
/Users/braden/conductor/workspaces/epicenter/yamoussoukro
```

This is the next-session implementation assignment. The preceding session
stopped to record the design before implementing it. Its premature context edits
were completely reverted; keep the substantial earlier implementation already
present in the checkout. Start with the readiness/context boundary below, then
finish the remaining recording and inference work rather than treating a context
rename as completion.

Use [the execution plan](20260922T170434-page-owned-resources-and-direct-native-transcription.md)
as the active work plan. Carry the implementation through completion, with
independent adversarial reviews between major waves. Do not stop after another
plan or after returning a review. Resolve findings, update remaining work, and
continue within the accepted scope.

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

Read the repository instructions and these decision records:

- `docs/adr/0392-product-boundaries-provide-required-resource-handles.md`
- `docs/adr/0415-runtime-replacement-ends-application-sessions.md`
- `docs/adr/0380-resource-handles-own-terminal-shutdown.md`
- `docs/adr/0423-app-resources-open-as-independent-handles.md`
- `docs/adr/0373-product-operations-receive-their-resource-handles-explicitly.md`
- `docs/adr/0365-ai-owns-inference-access-and-applications-own-workflow-selection.md`
- `docs/adr/0424-runtime-transcription-calls-the-host-directly.md`
- `docs/adr/0396-transcription-operations-preserve-destinations-and-results.md`
- `docs/adr/0425-a-transcript-is-separate-from-its-latest-attempt.md`

The user explicitly chose the following direction. Preserve it while verifying
the code and choosing implementation details:

1. Shared application handles use typed Svelte context. Name accessors `get*`
   and `set*`: `getLocal`/`setLocal`, `getPersonal`/`setPersonal`,
   `getStore`/`setStore`, and `getRecorder`/`setRecorder` where consumed. No `use*`
   or `provide*` aliases. The admitted working layout starts acquisition; its
   ready shell publishes concrete handles synchronously. Personal-only children
   mount only after a definite Account's Personal store opens. Their getter never
   returns undefined or a promise. Apply `fromData` at the ready boundary for
   reactive reads. Props remain for boundary inputs and component-specific values
   and callbacks. Operations receive explicit dependencies, not context lookups.
2. A page means a browser or WebView document. It captures one account context,
   possibly signed out, and can open multiple independent stores and namespaces.
   There is no SDK library primitive. Local is device-owned; Personal captures
   an account. Changing an already-open view does not itself require reload.
3. Page-root resources normally live until document replacement. Required startup
   failure is terminal until reload. Remove redundant aggregate product teardown
   only after proving the runtime owns its obligations. Individual failed openers,
   temporary operations, explicit shorter-lived access, and host cleanup retain
   their real responsibilities. Keep resource close contracts.
4. Personal, remote blob, and inference acquisition must leave independent local
   recording and data usable. A signed-in person can still choose Local recordings
   while using personal settings and account inference. Personal-dependent work
   waits or reports unavailability while its inputs are unavailable; it must not
   silently substitute device data or defaults for failed account acquisition.
   Personal readiness must not remount an active local workflow. Real departure
   must release old native access even if JavaScript never calls close. A stopped
   screen or navigation request is not destruction. Preserve an immediate work
   fence until replacement, stalled auth, and failed navigation are safe. Respect
   desktop credential persistence and process restart ordering.
5. Native transcription uses a narrow validated IPC resource. Delete its fake
   HTTP/SDK bridge after the direct path is proven. Keep actual SDK clients for
   network inference, including streaming. Browser runtime absence is null;
   broken providers and empty successful discovery remain distinct.
6. Catalog reads return metadata without constructing clients. Acquire saved
   execution access explicitly. Preserve hidden native keys, captured revisions,
   and retirement on destination/key edits or deletion.
7. Application operations receive the resources they need and preserve Results
   until a final presentation boundary. Retain saved blob IDs, remote URLs, and
   usable text through later failures. Retry the failed step, not an upload that
   already succeeded. Preserve delayed push-to-talk capture identity.
8. New recording transcripts start as null. Empty text means a successful empty
   transcript. Attempt state describes the latest attempt. Retranscription failure
   retains prior text. Transformations remain separate future work.

Use `local` and `personal` for concrete stores, and `store` for the selected
recording destination. Remove `library` as a handle alias without renaming
persisted storage keys. A product-specific async composition function is allowed,
but neither a live `export const app = openWhispering()` nor eager individual
opening exports are the target. The user considered those shapes and chose
layout-owned acquisition with context. Context does not own cleanup or make
store reads reactive; `fromData` handles reactivity and the existing lifetime
fences still protect departure.

Read the current starting state before editing:

- `apps/whispering/src/lib/whispering/resources.ts` still acquires Personal before
  constructing the recorder. Split readiness before moving optional checks into
  components; moving the same aggregate into a provider would preserve the bug.
- `app.ts`, `context.ts`, `ui-session.ts`, the working layout, and
  `_components/WhisperingShell.svelte` still expose a broad App and optional
  Personal. The shell already owns real recording/query cleanup; preserve that
  behavior while shrinking its dependency facade.
- Dictionary/instruction editors and recipes need required personal context.
  Recording lists need a required selected store. Device settings and local
  capture need local context. Check signed-in Local consumers: prompt, dictionary,
  recipes, and Polish do not follow the recording destination automatically.
- The interrupted task added `runtime-transcriber.ts`, host recording generation
  fencing, and shared boot changes. The old `native-ai.ts` bridge survives;
  verify and finish this transition rather than rebuilding it from scratch.
- Saved connection reads and recording outcome/transcript semantics still need
  the remaining plan's implementation and verification.

Capture your own starting status, name-status diff, staged and working-tree
binary diffs, and untracked contents. Do not infer authorship from dirty status.
Earlier snapshots, if present, are evidence rather than your execution baseline:
`/tmp/epicenter-execution-baseline-20260922T174034/` predates the earlier execution;
`/tmp/whispering-context-baseline.l6hwJS/` contains Whispering source before the
reverted context attempt. The latter's four changed files were restored
byte-for-byte and its two new components were removed.

The latest directly rerun check was `bun run --cwd apps/whispering typecheck`:
both targets passed with zero errors and warnings before the reverted edit.
Older native/browser test results are recorded in the plan and must be rechecked
against your final changes. The earlier physical microphone probe failed before
capture with CoreAudio OSStatus 560947818. No physical capture acceptance is
claimed. Compare documentation-hygiene diagnostics with your own baseline;
do not change formal ADR statuses to make that check pass.

Start by reconstructing the resource/caller map. Two independent design reviews
already converged on required ready contexts and separate account/destination
choices. Resolve construction and caller details without reopening that decision.
Run `adversarial-review` before removing remaining lifecycle machinery, after
the ready-context and Whispering page/host slice, after shared
consumer migration, after direct native transcription, after catalog acquisition,
and after the cumulative workflow changes. Reviewers are read-only. Use the skill's
independent reviewer setup when available and report limitations honestly. Preserve
the product promise while challenging each implementation and remaining plan.
Use local `post-implementation-review` after repairs.

Build replacements, switch real callers, verify them, then delete the old paths.
No aggregate App API, compatibility aliases, implicit upload source, generic
action runner, provider registry, or cross-resource transaction system. Retain
expected failures as Results; keep opening/closing rejection and unexpected bug
boundaries honest. Do not promote ADR statuses as a completion step.

Do not stage, commit, reset, delete branches, deploy, or migrate user data unless
separately requested. Do not change native shortcuts or redesign transformations.
Assess existing transcript/status data before proposing any rewrite. Use Bun.

Select focused checks from the plan and current package scripts. Re-establish
package and app typechecks, outcome tests, browser capture/playback, native
page/session evidence, catalog revocation, and network inference non-regressions.
Do not reuse previous test counts or equate synthetic browser capture with physical
microphone and installed desktop acceptance. Run `git diff --check` and compare
documentation-hygiene diagnostics with the starting baseline.

Done means the actual UI obtains ready shared handles through get/set contexts,
personal consumers need no optional-store checks, signed-in local use survives
account-feature acquisition failure, and no import opens resources. Ordinary
navigation must not duplicate acquisition; account replacement must retire old
work. The real applications use page-owned roots, optional inference fails
independently, native transcription no longer emulates HTTP, catalog reads are
inert, outcomes survive to their actual callers, and nullable transcript behavior
is coherent. Current documentation must match the implemented API. Return the
final API and callsites, concrete machinery deleted, verification performed, and
precise remaining blockers. A review checkpoint or passing library test suite
alone is not completion.
