# 0386. Recovery restores only verified backups and owns retry identity

- **Status:** Proposed
- **Date:** 2026-09-09
- **Unbuilt:** Authenticated recovery transport, restore orchestration, and the Backups screen. Portable verified publication, the persistent catalog, durable publication and restore intent, and the attempt journal are implemented but unmounted: there is no `restore()` method, no transport, and no package-barrel export.

## Context

A stored archive and an operation that replaces a library have different
lifetimes. The structural archive and storage checkpoints can capture values,
verify saved bytes, and prepare a fresh document. Their callers still have to
coordinate the destination backup, attachment installation, and activation.
Putting these helpers behind an object would leave that coordination with every
caller.

The [current-generation execution spec](../../specs/20260909T010040-current-generation-restore.md)
records those implemented checkpoints and the remaining integration. This record
specifies the recovery API and backup history for synchronized libraries.
Production does not currently expose restore. Local-only startup remains
available; a local-only recovery implementation is separate work.

## Decision

Every restore selects a verified backup from the library's persistent backup
history. Recovery owns the required destination backup, preparation, activation,
and durable retry identity.

One recovery object is bound to one library and its resources. Its intended
application API is:

```ts
recovery.backup()
recovery.import(file)
recovery.list()
recovery.download(backupId)
recovery.restore(backupId)
```

These names describe the target API. The unmounted `src/recovery.ts` coordinator
implements the first four; `restore` remains unimplemented. Its durable halves
exist behind a private `attempts` owner on the same coordinator: reserving one
unresolved attempt, publishing and retaining its single safety backup, pinning
the exact prepared activation request, finalizing a failure, and reconciling an
outcome. They are deliberately not a sixth public method. The factory binds
resources once; callers do not pass storage, capture positions, prepared bytes,
or operation IDs to individual actions. Fallible operations return Results.

`backup()` captures the authoritative library and saves a complete archive.
`import(file)` saves an uploaded archive without changing the live library.
Both publish a backup record only after the immutable file has been stored,
read back, and validated. `list()` returns published records for this library.
`download(id)` retrieves the exact saved archive. `restore(id)` resolves that
same record and replaces the library from its verified contents. There is no
public restore-from-bytes overload.

The stable library authority owns the catalog outside the replaceable document
and generation log. Restoring a library never restores or erases its backup
history. Records identify manually created, imported, and pre-restore backups.
An imported backup is a recovery point available here; it is not a claim that
its contents previously existed in this destination.

Object storage holds immutable archive files. Hosted storage uses the existing
S3 connection to R2; self-hosted storage can use its configured provider. R2 keys
and presigned URLs are implementation details. Catalog publication means more
than an object appearing in a bucket listing. Authorization resolves the backup
inside the selected library, and retention protects objects required by its
catalog and active restore attempts.

The unshipped structural archive uses version 2 with separate application and
data-definition IDs. Version 1 is refused because it supplies neither. Source
generation/head describe the capture; authority-recorded addition time describes
publication. Import preserves the whole original file, including whitespace.
The catalog digest covers those exact bytes, independently of the format's
parsed-body integrity check.

Recovery objects use `<stable authority name>/backups/<id>`. Generic attachment
routes construct `<library prefix>/blobs/<id>` and cannot reach them. Archives
embed their attachment bytes, so deleting an ordinary attachment does not remove
it from an already published recovery point. Provider/account deletion policies
remain separate from this protection.

After explicit user confirmation, restore captures the destination and creates
its required backup through the same publication path. It verifies the selected
archive, reconstructs a fresh Yjs lineage, and installs and verifies required
attachments. Activation compares the destination position covered by the safety
backup. Source generation and head are provenance, never the destination
condition. Accepted intervening writes cause a conflict; recovery does not
silently capture a newer position and try again.

Recovery creates and durably retains each restore attempt's internal identity,
source backup, destination condition, safety backup, and exact replacement
bytes before activation. Retries reuse that request and resolve its receipt.
Reconstructing again is a new lineage, not a retry. A pending attempt must be
reconciled before another is started or its source file is fetched again. An
already committed outcome is recoverable from its durable receipt even when
archive storage is unavailable. The UI can retry without manufacturing an
ID; after reconciliation, deliberately restoring the same backup again creates
a new attempt. Private transport requests still carry identity even though the
application API does not.

A definitive preparation failure records a failed-without-activation outcome.
The authority fences late activation for that attempt before releasing its active
slot, while retaining completed backups. An unknown activation outcome remains
pending until reconciled. Failure finalization and activation share the same
serialization boundary so neither can race past the other.

The coordinator prepares application data; the authority remains an opaque-byte
transaction owner. It atomically checks the destination, installs the new
generation, and records the activation receipt. Devices retire their replicas
and reload through the normal application lifetime path.

## User experience

The Backups screen offers Create backup and Upload backup. Each published entry
has Download and Restore actions. Upload validates and adds the file to the
history, then selects it and offers Restore this backup. There is no forced
return to the list and no automatic replacement merely because a file uploaded.
A canceled or failed restore leaves its imported backup available.

The pre-restore backup also remains available if activation fails. Its label
must not imply success: Before restore attempt is accurate. Display when an
import was added; show an original capture date only when the format supplies
it, and distinguish uploaded descriptions from authority-recorded metadata.
Backup content preview, schedules, and a deletion or retention-policy UI are
separate work.

## Consequences

Callers select a recovery point and ask for an action. They no longer assemble
a restore from capture, save, install, and activate calls. Manual and automatic
backups share one storage and publication guarantee.

Restore requires a published server-side backup and available storage for the
safety copy. Direct restoration of a local file without first saving it is
intentionally absent. A backup cannot include unsynchronized work held only by
another device. Retired devices discard that work when they reconnect.

Removing operation IDs from the public API moves responsibility into recovery;
it does not remove durable operation records or response-loss ambiguity from
the implementation. Recovery must resolve an interrupted attempt before treating
a repeated user action as a new one.

## Considered alternatives

- Accept either archive bytes or a backup ID in restore: creates two entry paths
  with different publication and recovery guarantees.
- Require the person to return to the backup list after uploading: adds navigation
  without strengthening the requirement that restore uses a published backup.
- Expose save and install methods on an archive object: binds dependencies but
  leaves destination coverage and activation ordering with the caller.
- Require callers to supply a restore operation ID: exposes bookkeeping that
  the recovery lifetime must already persist and recover.
- Use the backup ID as the operation ID: cannot distinguish retrying an attempt
  from deliberately restoring the same backup again later.
- Expose public prepare and commit phases: no product decision requires the
  caller to manage the intermediate state.
- Store backup history in the application document: restoring an older document
  could erase the history needed to recover from that restoration.
