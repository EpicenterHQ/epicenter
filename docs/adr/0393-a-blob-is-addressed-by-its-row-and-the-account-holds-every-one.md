# 0393. A blob is addressed by its row, and the account holds every one

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** [ADR-0091](0091-blobs-trade-a-file-for-a-durable-content-addressed-url-documents-are-the-only-manifest.md) at the whole mechanism: there is no content-addressed URL, no `/api/blobs`, and no citation found in prose; what survives is "documents are the only manifest", now literally, because the row is the address. [ADR-0154](0154-blob-access-is-address-only.md) at "takes a `BlobId` the caller already holds": the address is the row. [ADR-0349](0349-blobs-are-a-namespace-on-the-handle-addressed-by-id-and-stored-under-the-replicas-principal.md) (`Proposed`) at blob identity, the `principals/<id>/blobs/<blobId>` key, `uploadedAt` as the signal of a remote copy, the auto-upload preference, and its refusal of row-addressed blobs; its session-scoped local stores, Web Locks, erase, and legacy claim stand as the device cache. [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) and [ADR-0092](0092-identity-is-the-partition.md) at the R2 key and the public blob routes. [ADR-0205](0205-a-recording-is-a-row-that-fills-and-a-crash-finishes-it-rather-than-losing-it.md) at "the recorder returns the id at `stop`": it returns nothing but bytes at a row path it was given at `start`. [ADR-0355](0355-local-and-account-sessions-share-the-application-data-api.md) at "audio is a string field containing a blob ID, with a separate `uploadedAt`". [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) at "content-addressed" (immutable stands) and at "`uploadedAt` is null until an upload succeeds" (it stays as the queue marker, not as a choice). [ADR-0314](0314-an-app-is-one-directory-and-installation-is-a-rename.md) at "a blob id is a minted nanoid".
- **Supersedes:** [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md) (`Proposed`), whose at-most-one-blob-per-row rule and row-lifecycle claim are this record, without the write-once slot and without `table.blobUrl`. [ADR-0148](0148-blobs-use-opaque-identifiers-rather-than-content-hashes.md) and [ADR-0149](0149-local-blob-stores-are-canonical-and-remote-replication-is-explicit.md) are already superseded; this record ends the id lineage the first began and inverts the second.
- **Relates:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md), [ADR-0325](0325-a-database-is-bound-to-one-authority-and-re-homing-is-export-and-import.md) (a reference travels; bytes travel with export and import), [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md) (the upload queue is that obligation), [ADR-0394](0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md) (a kept copy is the second thing that keeps bytes alive), [ADR-0287](0287-the-authority-does-not-delete-a-generation-and-erasure-is-an-account-operation.md) (the server reclaims only what a person un-names).
- **Unbuilt:** All of it. `packages/blobs/src/blob-id.ts`, the `keyPath: 'id'` stores in `browser.ts` and `bun.ts`, `mint_blob_id` in `apps/epicenter/src-tauri/src/blobs.rs`, `packages/server/src/routes/blobs.ts` and `principal.ts#blobKey`, the host blob API in `apps/epicenter/src/server.ts`, the `generateBlobId` path in `packages/data/src/store/store.ts`, and Whispering's storage badges, Upload/Download/Remove actions, and Backup Status card are what this record replaces. The one production blob field is `recordings.audioBlobId` in `apps/whispering/src/lib/data.ts`.

## Context

A blob has had an identity of its own since ADR-0091: a hash, then a minted
nanoid (ADR-0148), carried in a `field.blob()` cell, keyed per principal at the
authority and per session scope on the device (ADR-0349). Every consumer pays
for that second identity. `store.create` mints an id and copies bytes in;
`BlobStore.copy` exists for that path; `archive.ts` finds a library's
attachments by running a regex over prose; a kept copy of the library would
need a list of the ids it names, stored beside it so the authority could
answer which bytes are still wanted; the recorder mints an id at `start` and
the application writes it at `stop`; and Whispering carries `uploadedAt`,
`recordingAutoUpload`, and four availability states so a person can decide,
per recording, which copies exist.

Under ADR-0393's first draft a blob was cited by exactly one `field.blob()`
cell on exactly one row, one blob field per table, never shared. Once that is
the rule, the row already names the blob uniquely, and the second identity is
paying for nothing.

## Decision

**A blob is addressed by its row. The object at `<table>/<row-id>` is that
row's attachment, and there is no other name for it.**

```txt
authority   R2 object  <library prefix>/<table>/<row-id>     Content-Type as object metadata
device      cache      the same path, in the session-scoped store ADR-0349 built
folder      file       <table>/<row-id>.<ext>                 beside <table>/<row-id>.md
cell        field.blob()   the attachment's MIME type, or null when the row has no bytes
```

A table declares at most one `field.blob()`; `compileData` refuses a second.
`BlobId`, `generateBlobId`, `BLOB_ID_ROUTE_REGEX`, `BlobStore.copy`, and
`createAppBlobs().add` are deleted. `CreateRowOf` takes bytes for the cell and
`store.create` puts them at the row's path and writes the MIME type; nothing is
minted. `store.update` cannot touch the cell. Changing the bytes is a new row.

**Bytes are immutable at their path, and a row keeps its bytes for life.** An
object exists from the row's creation until the reclaim pass in ADR-0394 finds
no copy that holds the row. Nothing else creates, replaces, or deletes an
object, and no request deletes bytes immediately. A capture in progress writes
to the path of the row the recorder was told it is filling
(`apps/epicenter/src-tauri/src/recorder/commands.rs` takes the row id at
`start` instead of minting a blob id); a capture whose row is never created is
reclaimed the same way.

**The account holds every blob, and the device is a cache.** Creating a row
with bytes leaves an obligation to push them, as ADR-0171 already says of every
durable local write; `uploadedAt` on the row is the marker of that obligation,
and Whispering's single-flight `kick()` is the runner. There is no preference
to keep audio on one device, no per-recording upload or purge action, and no
availability state beyond "cached here or not". `removeLocal` clears the cache
and `download` fills it. A person is told once, in settings: "Recordings are
stored in your account. This device keeps a copy of the ones you play."

**Blob requests go through the library's mount.** Four routes, resolved by the
same bearer and library prefix as `CURRENT_ROUTE` in
`packages/server/src/store-sync/mount.ts`, handled by the library's Durable
Object so that the object that owns the log and the kept copies also owns the
bytes:

```txt
PUT    /api/libraries/:appId/:library/data/:dataId/blobs/:table/:rowId    create-only; 409 when present
GET    /api/libraries/:appId/:library/data/:dataId/blobs/:table/:rowId
HEAD   /api/libraries/:appId/:library/data/:dataId/blobs/:table/:rowId
```

There is no DELETE and no list (ADR-0154 stands for clients). The durable read
URL of ADR-0091 is the GET above, durable for the life of the row.

**In the folder, the bytes sit beside the row.** `parseRowPath` in
`packages/data/src/artifact/layout.ts` learns the sibling as a second shape:
same table, same row id, an extension other than `md`, and it is that row's
attachment, never a second row. The extension is chosen from the cell's MIME
type through a small map with `.bin` as the fallback; the frontmatter cell is
the source of the MIME type on import, not the extension. `push` in
`packages/data/src/artifact/checkout.ts` plans no item for the cell.

**Attachments in rich text are rows.** An image in a Honeycrisp note is a row
in an `attachments` table with a `field.blob()` and a reference to the note.

## Consequences

The attachment set of a library, a copy, or a folder is the set of rows whose
cell is not null, and the authority can answer "which copies still hold this
row" with one query on a path (ADR-0394), because the path is the identity.

Deleted with the id: minting on both platforms, `copy`, the regex over prose,
the `blobs: { id, contentType, bytes }[]` array of the archive, the id
validation on every route, `/api/blobs/*` and `/api/apps/*/blobs/*`, the
per-principal key, `RemoteNotConfigured` as a state a person meets, Whispering's
`recordingAutoUpload`, the storage badge, the Upload and Purge actions, the
Backup Status card, and the `local-only` and `remote-only` availability states.

Every store rekeys. The browser store's `keyPath` becomes the row path; the
desktop and Bun directories become `<table>/<row-id>/`; R2 objects already
written under `principals/<id>/blobs/<blobId>` are moved once, by a job that
reads each recording row's cell, which is the same shape as the legacy claim
ADR-0349 built for the unscoped browser database.

Sharing bytes between rows costs a copy. Nothing in the tree shares. A table
that wants several attachments per row declares child rows.

`compileData` refusing a second blob field is a behavior change only for
`store-attachments.test.ts` and `declaration.test-d.ts`.

## Considered alternatives

- Keep a minted `BlobId` and store, beside each kept copy, the ids its folder
  names, so the authority could answer which bytes a copy still wants. Every
  piece of that list exists only because the id is not the row.
- Content-addressed ids. Refused before (ADR-0148, ADR-0349) because a
  recording's identity exists before its bytes are complete; under this record
  the recording's identity is the row's, which exists at `start`, and a hash
  would be a third name.
- Several blob fields per row. Nothing declares two.
- Device-only audio as a per-recording choice. It is what `uploadedAt` being
  nullable allowed, and it costs four availability states, two actions, a
  preference, and an export that can be missing files. A person who wants
  audio that never leaves a device uses a local library.
- Immediate deletion of bytes on row delete, refused offline. Deferred to the
  reclaim pass in ADR-0394, which needs no request to succeed.
