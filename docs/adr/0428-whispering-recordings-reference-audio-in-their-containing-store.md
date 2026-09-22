# 0428. Whispering recordings reference audio in their containing store

- **Status:** Accepted
- **Date:** 2026-09-23
- **Amends:** [ADR-0426](0426-copies-create-independent-blobs-at-their-destination.md) at its Whispering `remoteAudio` example only: saving to Personal creates an independent destination recording, rather than attaching a remote fallback to the source row. Fresh destination BlobIds and independent blob retention remain unchanged.
- **Unbuilt:** Local-only capture and import row publication, explicit Personal recording copies, store-relative playback and transcription, partial-save recovery, and removal of cross-store recording references.

## Context

Whispering captures audio into `local.blobs`, then creates a row in the selected
`library`, which can be Personal. Its upload operation creates a Personal blob
and patches the source row with `remoteAudio`: a BlobId, namespace, authority,
and principal. Uploading a Local recording creates no Personal recording row.

Playback, transcription reads, and availability checks first try Local bytes,
then compare the remote reference with the captured Personal identity. The same
row describes two storage locations. Removing the public identity property alone
would leave that relationship and its resolution rules intact.

## Decision

**A Whispering recording resolves its `audioBlobId` through the store containing
that recording.** The product creates a new audio-bearing recording only after
its referenced bytes have been published in that store. This is a publication
ordering rule, not a foreign-key constraint or a promise of permanent availability.
Later blob deletion or network failure can make audio unavailable.

```text
Local store                         Personal store
  recording A                         recording B
    audioBlobId -> Local bytes           audioBlobId -> Personal bytes
                 explicit copy
```

Manual capture, voice-activated capture, and imported audio first publish Local
bytes and a Local recording. Selecting the Personal view does not change the
capture destination or authorize upload. Capture completion identifies the Local
recording so the interface can show where it was saved. Local readiness does not
wait for Personal or inference acquisition.

**Save to Personal copies a saved Local recording into the captured Personal
store.** The operation captures the source row's values and both stores before
asynchronous work, copies audio with
`personal.blobs.copyFrom(local.blobs, audioBlobId)`, and creates a destination row
using the returned fresh BlobId. Field mapping belongs to Whispering. The
destination row receives a fresh row ID. The Local row and bytes remain unchanged.

The operation materializes detached content values before its first await and
constructs fresh destination content, including the recording's `content` field.
Retaining or spreading a row containing a live content node is not a snapshot.
The operation copies a snapshot of completed content. It does not transfer a
live transcription attempt. A later source transcript or title update does not
change the destination. Independently requested saves may create duplicate rows
and blobs. No association table, automatic reconciliation, or linked editing is
introduced to maintain a relationship between the copies.

Playback and computation receive the containing store. They resolve
`store.blobs.open(row.audioBlobId)` and `store.blobs.get(row.audioBlobId)`.
Transcription results update that same store's recording. Missing audio is
reported there; the reader does not search another store. Personal presentation
still requires the authorized playback transport in ADR-0427.

**Partial saves retain completed work.** Blob copy and row persistence are not
atomic. If copying succeeds but the row cannot be confirmed saved, the outcome
retains the destination BlobId, mapped row values, and any created row ID. A
retry of that row save uses the retained copy; it does not upload again. If row
creation may already have succeeded, retry must reconcile the known row rather
than blindly create another one. A lost blob-creation response retains the
uncertainty permitted by ADR-0426 and does not promise a recoverable unknown ID.

Capture, import, and Personal-copy success require destination-local durable
row persistence. With the current API, await `persistence.flush()` and inspect
`persistence.get()` for `saved`; a resolved flush alone can still mean failure.
Retain the minted row ID before awaiting persistence and retry existing
persistence debt rather than creating another row. This acknowledgement does
not prove that Personal metadata reached the server or another device.

Recovery remains bound to the captured destination. An in-memory retry may hold
the destination handle; recovery carried across page lifetimes needs explicit
credential-free destination identity and validation. Ordinary recording rows do
not gain those fields. No durable background job or exactly-once transfer is
required. Whispering checks its captured departure signal before row publication
or retry and after awaited persistence before presenting success. Auth retirement
alone does not make a retained cached document unwritable. Departure does not
delete already saved bytes or establish rollback.

The recording schema and readers lose `remoteAudio`. A Local row no longer has
remote playback fallback or a persistent uploaded-copy badge. A Personal row no
longer borrows the original Local file for playback. A separate text-only product
record can omit audio; this decision does not require a text-only save mode or
make absence an instruction to search another store.

## Consequences

This removes `ownsRemoteAudio`, per-recording account envelopes, manual upload
scope assembly, and the Local/remote resolution branches in audio reads and
availability. It does not require a generic scoped-reference SDK API.

New recordings initially appear in Local. Personal receives an independently
saved copy, so Personal metadata no longer appears automatically at Stop. Local
and Personal transcripts can diverge. Offline playback of the retained original
requires opening its Local recording. Preserving automatic fallback or linked
edits would require another association model and is outside this decision.

Source and destination stores retain their own lifetimes. Either close cancels
and drains admitted transfer work without closing its sibling. Blob deletion,
row deletion, and account replacement remain separate operations. Private
ownership checks and authentication remain necessary.

Existing rows may have Personal metadata pointing at Local bytes, or Local
metadata with a remote fallback. Changing a schema does not reinterpret those
addresses safely. Inventory and classify affected data before choosing an
explicit conversion or reset policy. This decision authorizes neither deletion
of existing data nor migration against a user's stores. Isolated fixtures can
exercise the replacement without that authorization. Inventory and an approved
disposition must precede enabling replacement readers over affected stores,
even when rollout would not rewrite any rows.

## Considered alternatives

- Return a generic `PersonalBlobReference` from `copyFrom`: moves cross-store
  resolution into the SDK while keeping the recording's two-location model.
- Store uploaded-copy associations in Personal: preserves fallback but adds
  lookup, repeated-upload policy, and a relationship between independent rows.
- Resolve every saved ID through the current account: changes the meaning of
  Local rows after account replacement.
- Upload at Stop automatically: couples capture to remote availability and
  transfers audio without the explicit Save to Personal operation.
