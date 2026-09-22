# Implement store-relative Whispering recordings

**Status**: Draft
**Date**: 2026-09-23

Implement the accepted store-relative recording design in
`/Users/braden/conductor/workspaces/epicenter/yamoussoukro`.

Read [the execution plan](20260923T012158-store-relative-recordings.md),
[ADR-0428](../docs/adr/0428-whispering-recordings-reference-audio-in-their-containing-store.md),
and [ADR-0429](../docs/adr/0429-store-handles-keep-account-identity-private.md),
then verify them against current source and callers. ADR foundation commit:
`8e02241510`. These decisions are Accepted but unbuilt. Do not mistake the
documentation foundation or passing old-model tests for implementation.

The target is simple: captures and imports save Local bytes and a Local row;
Save to Personal creates independent Personal bytes and a fresh Personal row;
each recording resolves audio only through its containing store. Delete the
relationship, not merely its spelling. Do not replace `remoteAudio` with a generic
reference envelope, association table, linked-copy state, or durable transfer queue.
Keep existing open constructors, distinct blob capabilities, and private account
capture; remove public store identity after its callers are gone.

Execute waves 0 through 4 in order. Use two fresh independent read-only adversarial
reviewers after each wave, following the plan and repository skills. Reconcile
their findings against live code, fix accepted issues, rerun checks, and continue.
Do not stop at another plan or a review result when safe implementation remains.
Move Local capture's downstream readers in the same wave. Build Personal readers
and playback transport before exposing Save to Personal. Keep document-lifetime
recovery receipts with a visible Finish saving action across component changes.

Preserve unrelated dirty work and existing direct native transcription. Snapshot
detached content before awaits; keep fresh destination IDs. Require local durable
row persistence, not just synchronous create or resolved flush. Keep known BlobId,
mapped content, and row ID for page-lifetime recovery without reuploading or
duplicating a known row. Fence late publication with the captured product departure
signal. Never resume an old attempt through a successor account.
Preserve captured account prompt/dictionary inputs when Personal opens late;
Local saving must not wait, but dependent transcription must not use silent
defaults. Confirm transcript persistence and retain text for retry without inference.

No production deployment, remote push, user-data migration/deletion, silent data
reset, or broad auth/catalog/boot redesign is authorized by this handoff. Identify
legacy address shapes and obtain a disposition before enabling replacement readers
over affected stores. Continue isolated implementation/tests while that release
gate is unresolved; report it honestly. Do not silently adopt ADR-0425's separate
transcript schema migration or promote other Proposed ADRs.
The disposition must cover old clients and pending offline writes, not only rows
present during inventory. No particular compatibility/version gate is authorized.

Verify the actual Whispering flow, including delayed Personal readiness, capture
while Personal is selected, partial persistence, source edits during transfer,
account departure, same-store playback/transcription, reload, and an isolated
second-client Personal read. Distinguish local durability from remote delivery,
synthetic capture from physical microphone, and library probes from product proof.
Report commands and results, deletion achieved, reviewer adjudication, data gate,
remaining blockers, and changed files. Update durable docs from evidence and delete
spent planning files when genuinely complete. Do not commit implementation unless
the executing user authorizes it.
