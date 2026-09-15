# 0393. A row owns its attachment, and the library synchronizes it

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** [ADR-0091](0091-blobs-trade-a-file-for-a-durable-content-addressed-url-documents-are-the-only-manifest.md) at the whole mechanism: there is no content-addressed URL, no `/api/blobs`, and no citation found in prose; what survives is "documents are the only manifest", now literally, because the row is the address. [ADR-0154](0154-blob-access-is-address-only.md) at "takes a `BlobId` the caller already holds": the address is the row. [ADR-0349](0349-blobs-are-a-namespace-on-the-handle-addressed-by-id-and-stored-under-the-replicas-principal.md) (`Proposed`) at blob identity, the `principals/<id>/blobs/<blobId>` key, `uploadedAt` as the signal of a remote copy, the auto-upload preference, and its refusal of row-addressed blobs; its session-scoped local stores, Web Locks, erase, and legacy claim stand as the device cache. [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) and [ADR-0092](0092-identity-is-the-partition.md) at the R2 key and the public blob routes. [ADR-0205](0205-a-recording-is-a-row-that-fills-and-a-crash-finishes-it-rather-than-losing-it.md) at "the recorder returns the id at `stop`": it returns nothing but bytes at a row path it was given at `start`. [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at "audio is a string field containing a blob ID, with a separate `uploadedAt`". [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) at "content-addressed" (immutable stands) and at "`uploadedAt` is null until an upload succeeds" (the obligation moves into the store's cache and the field is deleted). [ADR-0314](0314-an-app-is-one-directory-and-installation-is-a-rename.md) at "a blob id is a minted nanoid".
- **Supersedes:** [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md) (`Proposed`), whose at-most-one-blob-per-row rule and row-lifecycle claim are this record, without the write-once slot and without `table.blobUrl`. [ADR-0148](0148-blobs-use-opaque-identifiers-rather-than-content-hashes.md) and [ADR-0149](0149-local-blob-stores-are-canonical-and-remote-replication-is-explicit.md) are already superseded; this record ends the id lineage the first began and inverts the second.
- **Relates:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md), [ADR-0325](0325-a-database-is-bound-to-one-authority-and-re-homing-is-export-and-import.md) (a reference travels; bytes travel with export and import), [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md) (the upload queue is that obligation), [ADR-0394](0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md) (a kept copy is the second thing that keeps bytes alive), [ADR-0287](0287-the-authority-does-not-delete-a-generation-and-erasure-is-an-account-operation.md) (the server reclaims only what a person un-names).
- **Unbuilt:** All of it. `packages/blobs/src/blob-id.ts`, the `keyPath: 'id'` stores in `browser.ts` and `bun.ts`, `mint_blob_id` in `apps/epicenter/src-tauri/src/blobs.rs`, `packages/server/src/routes/blobs.ts` and `principal.ts#blobKey`, the host blob API in `apps/epicenter/src/server.ts`, the `generateBlobId` path in `packages/data/src/store/store.ts`, `field.blob()` in `packages/data/src/field/builders.ts`, Whispering's `uploadedAt`, and its storage badges, Upload/Download/Remove actions, and Backup Status card are what this record replaces. The one production blob field is `recordings.audioBlobId` in `apps/whispering/src/lib/data.ts`.


## The experience

Record on a laptop without Wi-Fi. Stop saves the audio locally, so it can
play immediately. Whispering shows an unfinished upload until the account
acknowledges it. On a phone, the recording's details may arrive first.
Whispering downloads the audio automatically while the library is open and
connected. Once the phone has saved it, playback works offline.

A device cannot play audio it has not received. The application shows that
absence rather than hiding a network wait behind Play.

```txt
Laptop                         Account                      Phone
create row ------------------> row synchronization -------> row visible
finish audio locally
play locally
upload ----------------------> immutable audio
                               download ------------------> save locally
                                                            play offline
```

This is the target, not current behavior. The implementation still uses
separate blob IDs and application-owned upload policy. See the
[implementation waves](../../specs/20260909T010040-current-generation-restore.md#implementation-waves)
for the backward path and completion evidence.

## Context

The existing byte API performs explicit one-shot local reads, uploads, and
downloads. That is a useful storage boundary. Whispering adds its own
`uploadedAt`, `recordingAutoUpload`, reconciliation runner, storage badges,
and copy-management actions to turn those operations into a product.

The library can own that policy once because every attachment belongs to a
row. Application developers still handle unavailable audio and display
failures; they no longer write delivery coordination.

## Decision

### One row, one attachment identity

A table declares at most one `field.attachment()`, replacing `field.blob()`.
The full identity is the stable library namespace plus table and row ID.
The namespace separates accounts and libraries and survives restore
generations. Backup IDs and generation numbers are not attachment identities.

```txt
current row -------+
Monday's backup ---+--> same library / table / row ID --> same audio
Tuesday's backup --+
```

The address identifies the attachment, not its contents. Equal files on two
rows are two attachments. Once completed, different bytes require a new row,
including after import or restore. Restoring a historical null cell does not
authorize overwriting an already completed attachment.

The cell records completion and content type; it never proves local presence,
remote presence, or backup completeness. Its exact encoding and any additional
metadata remain implementation work. Applications cannot update it directly.
A null cell means no completion is recorded in this version of the row; it
does not prove another device is still recording.

Honeycrisp notes with several files use child attachment rows linked to the
note. Each child owns one file. “Blob” remains a storage term for bytes in
`packages/blobs`; application authors work with attachments.

### The row comes first

The store creates the row ID. There is no application `mintId()` followed
by `create({ id })`. The recorder receives an existing row's attachment
as its destination. Creating with a file and completing a recording use the
same attachment owner.

Proposed API sketch, with Result handling omitted; these are target names,
not implemented exports:

```ts
const row = await recordings.create({ title, audio: file });
// Success means locally saved, not uploaded.

const pending = recordings.create({ title, audio: null });
const capture = await recorder.start({
  into: recordings.attachment(pending.id),
});
await capture.stop(); // Local completion; delivery is separate.
```

The owner must make completed bytes, the cell transition, and the upload
obligation recoverable across interruption. Deletion during capture or upload
must not recreate the row. Host-crash recovery requires staged-file recovery;
the existing startup sweep deletes staged captures. Row-first identity alone
does not establish recovery or power-loss durability.

### Synchronization eagerly supplies current attachments

The application chooses the destination through the library APIs (ADR-0401).
Recordings created in Local stay local, including after sign-in. Recordings
created in an account library automatically synchronize their audio along with
their rows; there is no separate upload opt-in. Local completion does not mean
an upload succeeded, and the UI must keep unfinished delivery visible.
An optional application workflow can copy local recordings into an account
after confirmation (ADR-0399); the destination then owns ordinary synchronization.

An account library owns one attachment synchronizer for its open lifetime:

- Completed local attachments owe an upload until delivery is confirmed.
- Current rows naming attachments absent locally owe a download.
- Received files stay in local attachment storage for offline use.
- Historical attachments named only by backups are not eagerly downloaded.
- A local library saves and reads locally, with no account transfers.

Transfers start on open, new work, and reconnect. Recoverable failures receive
bounded backoff with a scheduled wake-up while the owner remains open;
reconnect and explicit Retry can also wake it. A failed early download must
eventually retry after the originating device uploads, even if no row changes
again. Closing the library stops its workers; reopening recovers unfinished
work. No always-running operating-system service is promised.

Concurrency is bounded. Authentication, quota, and storage failures remain
visible and do not cause busy retries. Pause downloads is device-local,
preserves received files, and does not pause uploads. A person may prioritize
a recording without opting other recordings out of synchronization.
There is no automatic eviction or per-recording upload preference.

Local upload obligations belong to the store, durably recoverable with its
bytes. Download work can be reconstructed from current rows and local
presence. Downloaded files must not become newly owed uploads. No
application-owned `uploadedAt` or `kick()` survives. A synchronized
acknowledgment field is not required by this decision and must not be added
merely to guess another device's state.

### Reads tell the truth about this device

Reads perform local I/O and return local bytes or an explicit unavailable
result. They do not initiate or await network transfers. The UI observes
local availability separately from transfer progress and failures.

The target handle provides a local byte read and a local playable source.
A playable source retains the platform's disposal behavior: browser object
URLs have a lifetime; desktop playback can use the host's file-serving
route without copying a whole recording through the WebView. There is no
plain durable `a.url` that promises immediate authenticated playback, and
no public `evict()`.

The application owns recording and playback intent and error presentation.
The store owns completion, reconciliation, availability observations, and
shutdown. Platform byte adapters retain explicit one-shot I/O underneath.
A single attachment read failure does not stop row editing or other playback.

### Whispering shows availability and unfinished work

| Observed situation | Recording list or header | Interaction |
| --- | --- | --- |
| Capture active on this device | Recording and elapsed time | Stop |
| No completion recorded, no local capture evidence | No audio available | Read/edit details; delete |
| Local audio, upload pending | Player; header counts waiting uploads | Play, transcribe, save file |
| Missing local audio, download queued | Waiting to download | Prioritize |
| Download active | Downloading; measured progress when available | Use other recordings |
| Missing local audio while offline | Audio is not on this device yet | Read transcript; resume on connection |
| Transfer blocked or failed | Actual reason and Retry or corrective action | Local audio remains playable |
| Local audio, no unfinished transfer | Player | Play offline |

A remote not-found response is an observation, not proof that the origin
lost the file. A successful row sync is not an audio upload acknowledgment.
An upload acknowledgment is not proof that a backup preserves the row.

The normal list has no Storage column or per-row Upload/Remove-local controls.
“Save audio file” remains an export action. A library header summarizes
unfinished uploads and downloads and offers Pause downloads, Resume, and
Retry. Unknown local presence during initialization is not reported as
missing. A full device reports a storage problem; it never claims the
library is ready offline or silently evicts files.

Settings explains: “Whispering uploads recordings to your account and
downloads your current recordings to this device while the app is open.
Audio already on this device works offline.”

### Deletion follows rows; backups retain history

Deleting a recording removes its row from the current library. Devices stop
transfers and clean up local attachment copies when they observe that
deletion, coordinating with active capture and playback. Offline devices
cannot react until they synchronize.

An account attachment remains wanted while a current row or a retained backup
names it. Unfinished publication also requires protection. Physical account
reclamation belongs to ADR-0394 and must be proved before it is enabled.
Deletion never promises immediate erasure from every device or backup.

A restore brings back rows and schedules missing current attachments for
download. It cannot recover bytes that never reached any surviving source.
An export must report missing audio; a text backup must not masquerade as
verified attachment coverage.

Ordinary close and restore retirement have different meanings. Ordinary
close preserves saved local work and pending publication or delivery. This
does not turn explicit capture cancellation into a save: the application
finishes wanted capture before deliberate closure (ADR-0366). Confirmed retirement after restore
discards old-generation work, including recordings that completed locally
but never uploaded. It never automatically merges or rescues that work.
ADR-0395's confirmation names this loss and advises finishing both row sync
and audio uploads first. A device can keep working offline until it learns
retirement; those later edits are subject to the same discard rule.

Check generation admission before restarting row or attachment queues.
Stable attachment addresses do not authorize an old queue to write into a
new library generation. Keep matching local audio needed by restored rows;
row-state cache invalidation is not a wholesale attachment-store erase.
Obsolete local cleanup follows replacement reconciliation. Account files
retained by backups survive independently of local cleanup.

### Storage and transport preserve the identity

Device storage, remote access, and folder siblings resolve the same
library/table/row address. Folder bytes sit beside
`<table>/<row-id>.md` as `<table>/<row-id>.<ext>`. The cell supplies content
type; the extension is a rendering choice with a binary fallback.

The library authenticates remote access; knowing an address grants no access.
Exact route spelling and direct versus presigned transfer remain proof work.
The transport must handle supported recording sizes without materializing
large desktop audio in the WebView. There is no client-facing remote purge.

Create-only upload conflicts must distinguish an identical retry from
different content, including imports and restored rows. Presence or matching
size alone cannot establish equality. Verification may use an internal digest;
no public checksum or content-addressed identity is required. Folder edits
that replace bytes at an existing address must be refused explicitly.

## Consequences

Application code loses separate blob-ID minting, copy-to-a-new-ID workflows,
upload compensation, per-recording storage policy, and its reconciliation
runner. The shared store gains real transfer responsibility and observable
state. We remove duplicate coordination, not the facts that files may be
absent or transfers may fail.

Every device attempts to acquire the current library's attachments. That costs
bandwidth and storage. Large-file transport, browser storage limits, and
restart behavior need measured evidence; a small API does not remove those
costs. Pausing downloads is the initial control.

Existing objects and persisted rows require a verified migration before
removing deployed ID-based readers. New package READMEs must describe the
new API only once it exists. The implementation spec remains active until
the two-device offline journey, failure paths, and reclamation proof pass.

## Considered alternatives

- Explicit manual one-shot transfers: less synchronization machinery, but
  makes each person or application responsible for unfinished delivery.
  The low-level byte adapters retain this shape; the library owns policy.
- Download only on Play: saves bandwidth but leaves an unopened recording
  unavailable offline. Eager synchronization serves the chosen library promise.
- Network-fetching reads: hide latency and retry policy behind playback.
  Local reads plus observable synchronization keep availability explicit.
- Per-recording upload choices and eviction: add storage policy to ordinary
  recording use. A local library and device-level Pause downloads cover the
  initial product choices.
- A second blob ID or content-derived address: adds identity the row already
  supplies. Internal content verification remains necessary at conflicts.
- A timestamp as proof of present audio: records a past observation at most.
  Local reads and transfer results establish what this device can do.
- Backup-only garbage collection or a fixed grace period: cannot protect
  current rows omitted by an old snapshot or indefinitely delayed publication.
  Reclamation requires coordination, not elapsed time.
