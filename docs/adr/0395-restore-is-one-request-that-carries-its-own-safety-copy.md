# 0395. Restore is one request that carries its own safety copy

- **Status:** Proposed
- **Date:** 2026-09-12
- **Relates:** [ADR-0379](0379-reconstruction-is-an-explicit-destructive-library-operation.md) (`Proposed`, edited in place: no receipt survives a lost response, because a retry is refused by the position check and the person is looking at the restored library), [ADR-0394](0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md) (what a kept copy is), [ADR-0393](0393-rows-refer-to-blobs-without-owning-their-lifetime.md) (why restore moves no bytes)
- **Unbuilt:** All of it. `openCurrentAuthority` in `packages/data/src/sync/authority.ts` exposes `prepareActivation().activate()` with `_restore_receipts` and reads `_restore_attempts` for a fence and a pinned digest; this record removes all three and adds the safety copy. No route reaches it in production; only the Honeycrisp fixture worker's `activateForTest` does.

## Context

The restore the unmounted coordinator in `packages/data/src/recovery.ts` was
built toward is five requests that could each be lost: publish a safety backup,
upload prepared bytes, pin their digest to an attempt row, activate,
acknowledge. `sync/attempts.ts` holds the attempt with a partial unique index
over `status = 'pending'`, set-once fields, a `failed` fence, and `pending()`,
`acknowledge`, and `fail` so a page that reopened could learn what a previous
page left unfinished. Every piece bridges a gap between two of the five.

The activation transaction already compares the current generation and head to
an expected position, replaces the log, advances the generation, and retires
the hub after commit (`packages/data/evidence/current-generation/authority.test.ts`).
Nothing in it requires the four requests around it, and its receipt exists only
to make a retry polite.

## Decision

### Ordinary sync brings devices together; restore replaces their library

Restore makes the selected backup the current library on every device. It
does not merge that backup into today's library. The new generation refuses
old queued edits and attachment operations. Devices that discover retirement
discard unsynchronized work from that generation and reopen the replacement.
There is no abandoned-work inbox, rescue queue, or automatic re-import.

This deliberately includes completed recordings whose upload never finished,
and work made offline after another device restored. A device cannot know a
restore occurred until it reconnects. Network failure alone never authorizes
discard; confirmed generation retirement does.

For example, Monday's backup predates an interview recorded on Tuesday:

```txt
Interview's rows and audio reach the account before restore
  -> pre-restore safety copy can preserve them
  -> Monday becomes current; interview is recoverable from the safety copy

Interview stays only on an offline laptop
  -> phone's safety copy cannot include it
  -> Monday becomes current
  -> laptop reconnects, discards old work, and adopts Monday
```

“Finish synchronizing first” means row changes accepted by the account and
audio uploads acknowledged. It makes work eligible for the safety copy;
it does not put that work into the selected historical backup. The system
cannot verify that every offline device has finished or prevent further
offline edits while restoration happens.

### Confirmation states the loss boundary

Name the library and selected backup time. Explain:

> Restore this backup on all devices?
>
> Whispering will save a safety copy of the current account library before
> replacing it. Work that has not synchronized from other devices will be
> discarded when those devices reconnect. Open Whispering on those devices
> and finish synchronization first if you want that work preserved.

Show the selected backup's audio coverage and the current account state's
coverage separately. Incomplete coverage does not prevent saving a safety
copy or restoring, but its omissions must be explicit. Unknown coverage must
not be reported as zero missing files. A failed attempt to inspect coverage
is not proof that the audio is absent. An offline device that later learns
retirement explains that the library was restored and its old work discarded.

### Replacement and the safety copy commit together

**A restore is one request, and the authority keeps the safety copy in the
transaction that replaces the library.**

```txt
POST /api/libraries/:appId/:library/data/:dataId/restore
multipart:
  safety     the current library rendered as ADR-0394 entries
  state      the reconstructed Yjs state, a fresh lineage
  expected   { generation, head }   the position `safety` was rendered from
```

In one transaction the authority refuses `conflict` when the current
generation or head differ from `expected`; inserts `safety` as a kept copy with
`automatic = 0`; replaces the log with `state`; advances the generation. After
the commit it retires the hub, as `activate()` does today, so a rollback leaves
the admitted sockets usable. The transaction has no state before it runs and
none after it fails. No object moves during activation. Retained copies
protect existing referenced bytes; they cannot supply audio that was never
uploaded or was absent from an import. The safety copy retains the rows
replacement drops. Missing restored audio stays explicitly unavailable.
After reload, ADR-0393's synchronizer downloads missing attachments for current
rows. Historical null cells never authorize replacing previously completed
bytes at the same row address.

**`expected` is a data-safety check, not a courtesy.** The safety copy is
rendered by the client from its replica. If another device pushed an edit the
client has not received, `expected` is behind the authority, the restore is
refused, and the person sees "the library changed while you were restoring;
try again". Trying again renders a new safety copy that has that accepted
edit. The safety copy covers the captured account state through the folder
codecs. It cannot include unseen offline work, and its row files cannot
supply audio that never reached the account. It is not a guarantee of complete
reversibility.

**There is no receipt and no operation id.** `restore(id)` downloads the copy,
reads it into a fresh document through the table codecs, renders the current
download as `safety`, and sends the request. A retry after a lost response is
refused `conflict` if the expected position has moved. Reopening loads the
actual current library. A lost response or retirement alone does not prove
this particular request won: another restore may have advanced the generation.
Do not blindly submit a fresh replacement after an unknown outcome or report
the selected backup as restored without evidence tying success to this request.
There is no client recovery journal; the UI returns to the actual current
state and permits another deliberate restore.

Each multipart part is read through the same 16 MiB streaming refusal that
`StoreAuthority.fetch` applies to a baseline body.

**Retirement fences old work before reopening.** Sockets receive `retired`;
replicas discard their old row-state cache under the library claim.
`createDeparture` closes the App and reloads. Admission must precede resuming
old row queues and attachment work on every reconnect. In-flight byte requests
must not resurrect retired rows or bypass account retention.

Row-state invalidation does not mean wiping local attachment storage.
Reuse matching immutable files needed by restored rows. Discard abandoned
old-generation work under this policy; do not move it into a recovery queue.
Reconcile obsolete local files only after identifying the replacement's
requirements. Account objects retained by any backup remain protected under
ADR-0394.

On the initiating device, retirement may arrive before the HTTP response.
The screen shows "Restoring…" until departure and reopens the current library.
A confirmed response can establish request success; departure alone establishes
only that the old generation is no longer current.

## Consequences

`_restore_attempts`, `_restore_receipts`, the partial unique index,
`pinPreparation`, the `failed` fence, the digest comparison, `pending()`,
`acknowledge`, `fail`, the client journal, and every test that drives them are
deleted.

A restore costs one render of the current library plus one request, the same
as `backup()`. Its body is text and state under the existing cap.

Two people restoring at once are serialized by the Durable Object; the second
sees `conflict`. Two tabs on one device cannot both hold the App, because the
library claim is exclusive, and the recovery object without an App goes
through the same authority.

Restoring the same copy twice, deliberately, is two restores and two safety
copies. There is no "abandon" and nothing to abandon.

The safety copy is rendered by client code and is exactly as faithful as every
other copy.

## Considered alternatives

- Five requests with a durable attempt row, pinned digest, fence, and client
  journal. Every part bridges a gap a single request removes.
- Two requests, safety copy then activation. Half the machinery, and an extra
  kept copy on every crash between them.
- A client-minted operation id with a receipt table, so a retry could learn
  it already happened. Redundant with `expected`: after a commit the position
  has moved, the retry is refused, and the reload already showed the result.
- Restore without `expected`, last writer wins. Loses edits the safety copy
  never saw.
- The authority copies its own `_snapshot` and `_log` rows as the safety copy.
  Atomic and independent of client code, but a second shape beside the folder.
- Skip the safety copy because a daily copy exists. An on-open daily copy can
  lag the current account state. Capture that state in the replacement
  transaction, with codec fidelity and audio coverage explicitly bounded.
- Rescue or automatically merge old offline work. Refused: restore selects
  one historical library as current everywhere. Preserving abandoned work
  would require a second recovery workflow and weaken replacement semantics.
