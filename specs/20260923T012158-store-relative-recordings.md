# Store-relative recordings execution

**Status**: Draft
**Date**: 2026-09-23

Whispering saves captures locally and explicitly copies a recording to Personal;
each recording reads audio from its containing store.

## Decision and boundary

[ADR-0428](../docs/adr/0428-whispering-recordings-reference-audio-in-their-containing-store.md)
and [ADR-0429](../docs/adr/0429-store-handles-keep-account-identity-private.md)
are Accepted and unbuilt. They authorize the target, not a claim of implementation.
The ADR foundation is committed as `8e02241510`. This spec owns recording
ownership, Personal saving, reader migration, and removal of public store identity.
The [handoff](20260923T012158-store-relative-recordings.handoff.md) starts execution.

The prize is deleting the relationship between copies: no `remoteAudio`, account
envelope on recordings, fallback search, association table, uploaded badge, or
linked-edit reconciliation. A Local recording and its Personal copy are separate
records. Repeated deliberate saves may duplicate them. Personal selection does
not authorize sending captured audio remotely.

Preserve `openLocal(definition)` and `openPersonal(definition, { account })`,
private account snapshots, transport ownership, and unequal Local/Personal blob
capabilities. Remove public `personal.identity` only after its callers disappear.
Do not invent a common store wrapper, generic reference API, or durable transfer
queue. Do not rebuild the already implemented direct native transcriber.

ADR-0425's nullable transcript and attempt redesign, inference catalogs, broad
shared boot refactors, native persistence, Shared stores, and SQLite projections
remain separate. Fix only readiness dependencies needed for Local capture here.

## Current callers and target

Read the live source before editing. These are expressions of the change, not
new SDK exports or runnable operation signatures.

| Caller | Current behavior | Target behavior |
| --- | --- | --- |
| `recording.svelte.ts`, `save-audio-recording.ts` | Local bytes, row in selected `app.library` | Local bytes and durably saved Local row for manual, VAD, and import |
| `upload-recording.ts` | Copy blob, patch source `remoteAudio` | Snapshot source, copy blob, durably save fresh Personal row; source unchanged |
| `whispering/recordings.ts` | Try Local, validate remote scope, fallback | Open/get through the containing store; availability uses that store's actual capabilities, not a fabricated Personal stat method |
| `whispering/resources.ts` | Personal opening can delay recorder construction | Local capture becomes ready without Personal or inference |
| `packages/app/src/open-store.ts` | Public identity plus private captured account | Private captured account only; existing constructors and capabilities |

The operation receives Local and Personal handles plus the source recording and
the product departure signal. It retains them for the attempt. It never resolves
the destination again from a current-account getter.

### Snapshot and acknowledgement

Before the first await, map scalar content and materialize the recording's live
`content` node into detached values. Reconstruct fresh destination content through
the supported public API; do not spread or share an integrated Yjs node. Include
completed transcript/polished text and title. Preserve duration in milliseconds.
Map attempt-related fields deliberately so the copy never claims to own a running
source attempt. This does not require ADR-0425's schema conversion.

Copy with `personal.blobs.copyFrom(local.blobs, source.audioBlobId)`. Use the
returned BlobId and a fresh recording row ID. Retain that row ID before awaiting
durability. Row acceptance and a successful lookup are not durable acknowledgement.
With the present API, await destination `persistence.flush()` and inspect
`persistence.get()` for `saved`; `flush()` also resolves when storage is blocked.
This confirms local durability, not server receipt. Connection status is not a
per-row delivery acknowledgement. Cross-device acceptance requires observing
the actual recording and audio from a second isolated client.

If the row cannot be saved after bytes publish, return an operation-local recovery
outcome retaining destination handle, detached mapped values, BlobId, and known
row ID. Retry persistence or reconcile that same row without another copy/create.
`recordings.get(id) === undefined` can mean missing OR nonconforming; inspect the
available row-state API before deciding whether creation never happened. If the
public API cannot distinguish this safely, stop the retry with an explicit
uncertain outcome instead of creating another row.

Use page-lifetime recovery initially. Page loss may lose its receipt while bytes
remain; say so honestly. Unknown IDs after lost responses cannot be recovered by
inventing a reference. No automatic orphan deletion or reload-resume promise.
The working layout's document-lifetime owner retains pending receipts, not the
row button or a view-selected UI session that is recreated on navigation. Use
bounded in-memory state and a visible Finish saving action for both Local and
Personal publication failures. Ordinary route changes must not discard receipts;
account departure fences them and reload ends their promised lifetime. Prove
retry through the actual UI after the initiating component unmounts, with the
same BlobId and known row ID and no second copy. Successful saves discard their
receipt rather than creating a lasting association between recordings.
Check the captured product departure signal immediately before publication and
retry, and after awaiting persistence before presenting success. Auth retirement
alone does not make a cached Personal document unwritable. Preserve known completed
work in cancellation/failure results without borrowing a successor account.

## Execution waves

Each wave ends with the adversarial checkpoint below. Keep executable intermediate
states; use isolated fixtures until the existing-data gate is resolved. Do not
expose a half-migrated reader or silently change an existing address's meaning.

### 0. Baseline and existing-data gate

Read relevant package/app READMEs, current schema/callers/tests, and the two ADRs.
Record HEAD and dirty work. Inventory legacy row shapes in source and fixtures:
Personal rows can reference Local bytes; Local rows can carry remote fallback.
Identify what real-data evidence is missing without inspecting unrelated private
stores. Obtain the user's explicit conversion/reset/disposition decision before
enabling replacement readers over affected stores. No user-data deletion,
migration, or silent namespace reset is authorized. Isolated implementation and
tests can proceed while rollout remains blocked.
The disposition must also address older clients and their pending offline writes;
an old writer can recreate legacy addresses after a one-time inventory or
conversion. Establish that they cannot repopulate affected stores or leave
cutover blocked. This does not authorize a particular version gate or migration.

### 1. Local capture and publication

Make manual capture, VAD, and import publish a Local recording after Local bytes.
Personal selected, pending, or failed must not change that destination or delay
capture readiness. Preserve exact capture ownership and cancellation. Keep audio
recoverable if row persistence fails. Show where the Local recording was saved
even while the interface displays Personal. Keep automatic transcription tied
to that saved Local recording and captured inference selection.
Move its downstream pipeline lookup, transcription reads, and history writes to
the Local store in this same wave; do not leave them using selected `app.library`.
For signed-in captures, transcription must wait for its captured account's prompt
and dictionary inputs or report their unavailability, never silently substitute
defaults because Personal is still opening. Local saving proceeds immediately.
Personal becoming ready must not recreate the active recorder.

Transcript and polished-text writes require flush/status durability confirmation
before reporting history saved. Keep usable inference output when persistence
is blocked and expose retry without another inference request. Carry this same
guarantee into Personal transcription; it does not require ADR-0425 conversion.

Prove blocked persistence, capture during delayed/failed Personal acquisition,
Personal selected, import/VAD parity, and late completion after departure.

### 2. Same-store readers and presentation

Pass the containing store through playback, availability, transcription, and
transcript persistence. Never search Local for missing Personal bytes or resolve
Local data through the current account. Preserve completed transcript text on
failed retries without pulling in the separate transcript schema redesign.

Complete the authorized blob playback worker integration required by ADR-0427:
the host asset alone is insufficient; the real app needs the controlling worker
at the correct root scope. Check current implementation before adding anything.
Prove Local and Personal readers against isolated store-relative fixtures before
exposing the new Personal save writer. Existing-data reader cutover remains
subject to wave 0. Do not add a compatibility resolver to hide the gate.

### 3. Independent Personal save and product evidence

Implement the product mapping and operation-local recovery described above.
Wire a deliberate Save to Personal action to the actual UI only after wave 2's
reader/presentation path works. Prove fresh IDs, unchanged source, detached content
despite source edits during transfer, independent later edits, intentional
duplicate saves, one retained row on blocked persistence, UI retry without
reupload after component destruction, and retirement after blob publication.
Do not keep an uploaded badge implying a persistent relationship.

Exercise actual product capture/import, playback, transcription, explicit save,
reload, and Personal playback in an isolated second client. Report synthesized
audio separately from physical microphone and installed desktop evidence.

### 4. Delete obsolete surfaces and reconcile records

After callers use the new model, remove `remoteAudio`, `ownsRemoteAudio`, fallback
branches, scope assembly, relationship tests, and public `personal.identity`.
Audit all repository consumers before deleting an SDK export/property. Preserve
private snapshot and transport-isolation tests and genuine blob capability
differences. Remove redundant aliases only where the migrated callers no longer
need them, without turning this into the broader resource integration project.

Update package/app READMEs and ADR Unbuilt fields to match evidence. Keep older
Proposed ADRs Proposed unless separately authorized. Delete this spec and its
spent handoff when complete, preserving durable decisions and verification in
ADRs/reports. If rollout is blocked, retain the active plan and report that limit.

## Adversarial checkpoint after each wave

Use the `adversarial-review` skill. Give two fresh read-only Codex reviewers the
same baseline, actual diff, decisions, and evidence, without the coordinator's
preferred verdict or each other's findings. One starts with deletion and ownership;
the other with guarantees and recovery. Both may challenge the model. Request
files-read inventories, concrete blockers, replacement costs, and a verdict.
Do not give reviewers edit authority or allow recursive reviewers.

While they review, perform non-overlapping verification. Reconcile only after
both initial verdicts arrive. Validate findings against live code, fix accepted
findings, rerun affected checks, and record rejected findings with reasons. Do not
request another pair solely to get agreement. Bring back a changed product promise,
new data authority, or genuine unresolved architecture decision to the user.

## Verification and finish

Start from the current scripts; likely focused commands from the repository root:

```sh
bun test --isolate packages/app/src/open-store.test.ts packages/app/src/blob-copy.test.ts packages/app/src/store-blobs.test.ts
bun test --isolate apps/whispering/src/lib/operations/upload-recording.test.ts apps/whispering/src/lib/whispering/recordings.test.ts
bun run --cwd packages/app typecheck
bun run --cwd apps/whispering typecheck
bun scripts/check-doc-hygiene.ts
git diff --check
```

Rename obsolete test files with the implementation; add coverage for the wave
criteria rather than preserving tests of rejected behavior. Run affected package
suites and actual product runtime checks. Library media probes alone do not prove
the Whispering UI. Inspect current saved-recording browser harness requirements
before running it; provide model/audio prerequisites rather than claiming mocks
establish native acceptance.

The documentation foundation baseline at `c9728ab926b9` passed 17 toolkit and 15
Whispering tests, 145 assertions total. These test the old model. Doc hygiene had
61 existing issues. No replacement implementation, real-data disposition, full
typecheck, physical microphone, or cross-device acceptance was established here.

Done means the product flow works, recovery retains completed work, forbidden
cross-store relationships are gone, private isolation remains, existing-data
disposition is approved before cutover, reviews are reconciled, and runtime
evidence is reported with limitations. A successful typecheck alone is not done.
