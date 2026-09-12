# 0349. Blob bytes belong to one app and session scope, beside their replicas

- **Status:** Proposed
- **Date:** 2026-09-05
- **Supersedes:** [ADR-0173](0173-each-row-owns-at-most-one-write-once-immutable-blob.md) at its public operations, `table.blobUrl(rowId)` and `table.writeBlob(rowId, bytes)`. Neither exists and neither will: a blob is addressed by `BlobId`, not by the row that cites it. ADR-0173 is `Proposed` and its write-once slot was already withdrawn by [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md), so what is left of it after this record is a `Considered alternatives` entry.
- **Amends:** [ADR-0205](0205-a-recording-is-a-row-that-fills-and-a-crash-finishes-it-rather-than-losing-it.md) at "No blob identity crosses the boundary, ever. There is no `BlobId`", which is withdrawn: the recorder returns the id at `stop` and the application writes it into the row, which `apps/whispering/src/lib/whispering/recording-audio.ts` already does through `recording.audioBlobId`. Its row-that-fills rule and its refusal of a recorder-owned `cancel` stand. And [ADR-0314](0314-an-app-is-one-directory-and-installation-is-a-rename.md) at the spelling of app-scoped blobs, which now follows local or authority-plus-principal session scope; its one directory per app and its refusal of a shared root stand. And [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) at its open question of who tells the recorder where blobs live, which is answered below: the caller hands `start` the app and session scope.
- **Relates:** [ADR-0148](0148-blobs-use-opaque-identifiers-rather-than-content-hashes.md) (a minted nanoid, never a content hash), [ADR-0154](0154-blob-access-is-address-only.md) (address-only, no enumeration), [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (audio does not move into the page), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md), [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md) (`principals/<id>/blobs/<blobId>`, per principal and not per generation), [ADR-0325](0325-a-database-is-bound-to-one-authority-and-re-homing-is-export-and-import.md) ("a blob reference travels; the blob bytes do not"), [ADR-0348](0348-the-local-address-carries-the-principal-and-a-database-needs-no-binding-to-know-whose-it-is.md) (the principal is an address segment), [ADR-0342](0342-sign-in-is-the-door-to-keeping-not-to-using.md) (`Proposed`, edited in place: a trial has no blob store for the same reason it has no replica), [ADR-0149](0149-local-blob-stores-are-canonical-and-remote-replication-is-explicit.md) (`Superseded` by [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md); its `upload`/`download`/`purge` vocabulary survives here)
- **Amended by:** [ADR-0393](0393-a-blob-is-addressed-by-its-row-and-the-account-holds-every-one.md) at blob identity, the `principals/<id>/blobs/<blobId>` key, `uploadedAt` as the signal of a remote copy, the auto-upload preference, the per-recording upload and purge actions, and the refusal of row-addressed blobs below: a blob is the object at `<table>/<row-id>` under the library's mount, and the account holds every one. What stands from this record is the device cache: the session-scoped local stores and their names, the Web Locks, the erase, and the legacy claim.
- **Relates:** [ADR-0352](0352-an-account-s-data-and-a-device-s-files-are-two-packages-because-only-one-of-them-is-removed.md): account blobs are account data, while local blobs belong to the local session; which platform object owns the verbs remains open.
- **Unbuilt:** the platform answer for every application but Whispering. Built, in the browser: local scope uses `epicenter/<app-id>/local/blobs`, and account scope uses `epicenter/<app-id>/accounts/<authority-id>/<principal-id>/blobs`; each store can open nothing else. Built, on the desktop: the host writes `apps/<app-id>/local/blobs` and `apps/<app-id>/accounts/<authority-id>/<principal-id>[/shared]/blobs` under its data root (`apps/epicenter/src/main.ts`), and native capture writes the same layout from Rust. Only Whispering selects the host store; every other application in a host WebView still composes the browser store by default. Which object carries the blob verbs at the platform level is reopened by ADR-0352 and not answered here.
## Context

<!-- doc-path-check: ignore-next-line -->
Blobs today are Whispering's, not the platform's. `apps/whispering/src/lib/services/blobs/index.browser.ts` composes a browser store with a remote built from `authClient`, and every other application that wants bytes copies that file. Until this record landed its first slice, that composition opened `epicenter-blobs`, one IndexedDB database for the whole origin: two accounts on one browser profile shared every byte, which is exactly the failure ADR-0348 removed from the data address, and it is why Whispering has no "remove local data" action. An erase that took the generations would strand the audio, and one that took the audio would take somebody else's.

The remote never had this problem. The authority keys a blob `principals/<id>/blobs/<blobId>` (`packages/server/src/principal.ts`), per principal and not per generation (ADR-0276). The local store was the half that never caught up.

<!-- doc-path-check: ignore-next-line -->
There was a second, unrelated thing called blobs in the tree: a `Blobs` contract over document bytes in `packages/data/src/store/blobs.ts`, with no production caller. It is deleted, which ends the collision between `Blobs` (document bytes) and blobs (a person's files).

## Decision

**Blob bytes belong to the session scope, and the name says so. One grammar with
two substrates, scoped by app and either local or authority-plus-principal.**

```txt
browser local    epicenter/<app-id>/local/blobs                         (one IndexedDB database)
browser account epicenter/<app-id>/accounts/<authority-id>/<principal-id>/blobs
desktop local    <root>/apps/<app-id>/local/blobs/<blob-id>/             (host filesystem)
desktop account <root>/apps/<app-id>/accounts/<authority-id>/<principal-id>/blobs/<blob-id>/
```

The browser name is the sibling of the local or account data address (ADR-0348).
Account scope includes both authority and principal; local scope has neither.
The account identity is in the name for confidentiality and erasure: removing
one account's local data must leave another's, and a second person signing in
on a shared laptop must not reach the first person's recordings.

**Per session scope, not per data id and not per generation.** An account
authority keeps one copy per authority-plus-principal, while local state has one
local copy. One `BlobId` is cited by exactly one row in one data id (ADR-0393),
and the scope is still the session rather than the data id because the store is
opened once per session and every data id of the app reads it. A restore mints a
new generation citing the same ids, so a per-generation store would copy or
orphan every blob.

**`blobs` cannot collide with anything the replica address produces, and the grammar is what guarantees it rather than a reserved word.** A data id is reverse-domain and must contain a dot (`packages/data/src/definition/addresses.ts`), so no data id is a bare word. Generation enumeration matches `<data-id>/` with its trailing slash and requires the remainder to be a number, so it never sees a sibling. A test in `@epicenter/data` pins that a dotless segment is never a data id, which covers any later bare-word sibling under the account prefix the same way.

**The store takes the scope and never a name.** `createBrowserBlobStore` in
`@epicenter/blobs/browser` takes `appId`, `principalId`, and optional
`authorityId`, deriving either local or account scope through
`browserBlobStoreName`. There is no `databaseName` option and no default, so an
unscoped store cannot be built by omission. Each segment is refused rather than
canonicalized, under the rule the replica address and a desktop partition
already use: not empty, no path separator, and not `.` or `..`.

**Desktop blobs use the same scope below the app directory.** Local bytes use
`apps/<app-id>/local/blobs/`; account bytes use
`apps/<app-id>/accounts/<authority-id>/<principal-id>/blobs/`. Device files keep
their existing app-scoped location; erasing account blobs deletes the exact
account directory, never its authority or app parent. There is no generation
segment: a restored row still cites the same opaque bytes. The host writes these
desktop spellings under its data root.

**An application's blob store is built per session from its captured replica.** The opened App composes it in `packages/app/src/open.ts` from the replica identity and, for an account library, the account's transport; the local store uses the principal and the remote uses the retired-on-sign-out transport. The result is `app.blobs`. ADR-0352 leaves the platform owner of the verbs open.

**There is no `list`,** which is ADR-0154 unchanged: the application's own rows are the inventory, and a blob whose every citing row is gone is unreachable.

**A row records whether its blob is uploaded; the blob store does not.** Whispering's `uploadedAt` is the instance: `availability` in `recording-audio.ts` reads `stat` for local bytes and the row's `uploadedAt` for the remote copy. `stat` answers size and content type about this device and nothing about the authority.

**Desktop bytes stay on the host filesystem.** ADR-0226 refuses moving them into the page and states the price: the Rust progressive writer needs a filesystem, multi-hour captures do not belong in IndexedDB, and an upload streams from the host instead of crossing WebView IPC. `recorder/blob.rs` will take the session scope `{ appId, authorityId?, principalId }` at `start` and join it, which answers ADR-0201's open question about who tells the recorder where blobs live.

**The browser codec keeps storing `ArrayBuffer` plus content type.** WebKit rejects persisted `Blob` and `File` values (`packages/blobs/README.md`), so the store reconstructs a `Blob` on read. That stays until `bun run smoke:webkit` in `packages/blobs` proves otherwise.

**Erasing an account's local data erases its blob database.** It is a second explicit delete beside `eraseGenerations` rather than a widened filter, because `blobs` is not a generation number and enumeration must not learn to see it. It takes the same captured principal the generation erase takes, so forgetting one person's copy on a shared device leaves the other person's alone, and it never purges the authority's copy. Every ordinary operation holds a shared Web Lock, including byte conversion before a put. Migration shares the scoped lock and holds the legacy lock exclusively, so recording can continue while bytes move. Erase takes the exclusive lock and refuses conflicts. A blocked delete reports failure after ten seconds but retains its lock until IndexedDB settles, because the pending request cannot be cancelled. The caller must stop producers before erasing: operation locks exclude in-flight work but cannot prevent an idle surviving handle or a new session from creating the database later.

**The bytes an earlier build wrote to `epicenter-blobs` are claimed by row, never swept.** Rows are the inventory (ADR-0154): a claim moves, for each of this account's rows, the blob its `audioBlobId` cites from the unscoped database to the scoped one, idempotently. Bytes no row of this account cites belong to somebody else or to nobody, and ADR-0351 forbids deleting bytes of unproven ownership; they stay, counted and sized by their metadata and never listed, and the recording settings page tells a person how many audio files and how many megabytes, that some may be another account's, and offers the delete. Even an empty legacy database is never deleted automatically. The claim is a move: a reference travels between accounts and the bytes do not (ADR-0325), and under ADR-0393 one id has one citing row, so a claim has one owner to move it to.

**Backup is a count and a button; the rows are the queue.** Whispering shows the account-wide count of rows with `uploadedAt === null` synchronously from its cached recordings, including when online backup is unavailable. Rendering that count performs no storage reads. The button calls `backup.kick({ refreshLocal: true })`. Session open, `window.online`, and row creation after committed audio call the same coalescing, single-flight `kick()` under the auto-upload policy and remote availability. There is no timer, outbox, pending index, transfer log, or polling-derived reconnect event.

**Discovery batches local metadata and remembers confirmed absence for this session.** `BlobStore.statMany(ids)` is address-only and the browser reads the supplied ids in one metadata transaction. The runner remembers every confirmed `BlobNotFound`, including results after an early upload failure, so other-device rows cost one read per session. Storage failures remain retryable. A manual click clears that memory to discover bytes another tab may have written. Successful local writes invalidate the relevant absence, and a revision check prevents an older discovery from restoring it. Missing bytes prove only absence on this device; the UI does not claim they exist elsewhere.

**Migration settles before backup discovery.** The recordings domain starts one claim from its hydrated rows and exposes `audioReady`. Backup and local availability await it; the UI invalidates cached availability after the attempt settles, including a partial failure. The runner rechecks the current row and remote availability before each upload, sends one at a time, stops after two consecutive failures, and stops scheduling work after disposal. Coalesced calls share one report that includes successful uploads from every pass. The explicit per-recording upload action remains separate from these backup triggers.

**Auto-upload is an account preference.** `recordingAutoUpload` stays in account KV and syncs. Settings tells the person that every device follows it and each sends the bytes it holds. Turning it off stops automatic discovery; a manual click still runs.

**Row creation waits for failed-write cleanup.** `recordings.create` commits the row synchronously, returning an asynchronous Result so a failed write can await deletion of the already-committed audio. Its error preserves both the write failure and any cleanup failure. The pipeline marks failed dictation visibly and enters transcription only after successful creation.

## Consequences

- **Two accounts on one browser are two databases, and neither can address the other's.** The guard is the name, which is the same guard ADR-0348 chose for the replica, and it cannot be forgotten because a store that does not carry it cannot be constructed.
- **A shipped browser device meets its own audio again on the first session after the upgrade,** because the claim runs at session start over the rows it holds, and the recordings page's cached availability is invalidated when anything moved. What it cannot recover is audio whose row never synced under the stranded `v4` records (ADR-0348): those bytes are in the origin's quota under `epicenter-blobs` with nothing pointing at them, and they are what the unclaimed count reports.
- **Whispering's browser build offers "sign out and remove local data" and its desktop build does not.** The popover takes the callback only where the promise is whole (ADR-0351), and the seam is what decides: the browser leaf exports the erase, the desktop leaf exports null.
- **A blob orphaned by an erase is unreachable from every device, forever.** Address-only means the citing row was the only index. This is the gap ADR-0325 already accepts for re-homing, and the backstop is the authority's account-deletion sweep, which ADR-0154 preserves as a deployment operation rather than a public route.
- **The host's local-blob routes gain the session scope and a scoped delete.** `/api/local-blobs/*` in `apps/epicenter/src/server.ts` gates on a browser session, not on a principal, and reads one flat directory. Under this layout the route resolves the local or account-scoped blob directory from the caller's app and captured session, and the desktop erase deletes that exact scope.
- **The recorder's signature changes and its tests change with it.** `start` takes two more strings, and `blobs_directory` stops reading the platform default it currently resolves natively.
- **A blob still cannot be shared between two accounts on one device.** The same bytes uploaded by two accounts are two objects in two databases and two objects in R2. Deduplication was never available anyway: ADR-0148 made the id a mint rather than a hash.
- **`@epicenter/blobs` depends on `@epicenter/principal`** for the brand, and on nothing else new. It cannot import `isAppId`, because `@epicenter/constants` already depends on this package for the route grammar.

## Considered alternatives

- **Blobs as a namespace on the `createEpicenter` handle, with `RemoteUnavailable` as a typed error in place of `remote: BlobRemote | null`.** This record's first draft. Withdrawn by ADR-0352, which deleted the binding the namespace was to sit beside and reopened which object carries the verbs. The nullable remote and Whispering's `requireRemote` helper survive for now.
- **Row-addressed blobs, ADR-0173's `table.blobUrl(rowId)` and `table.writeBlob(rowId, bytes)`.** Refused at the operations, not at the ownership: ADR-0393 makes one blob per row the rule for every table; on desktop the id exists before the row is final, because the recorder mints it at `start` and the application writes it at `stop`, which is why the verbs take an id and not a row; and "pure, synchronous, a stable URL" was only ever true on the arrangement where a host serves the bytes, which is half the platform.
- **Put every blob in IndexedDB and drop the host filesystem.** Refused on ADR-0226's terms: it costs the Rust progressive writer, puts multi-hour captures in IndexedDB, and routes uploads through WebView IPC instead of streaming.
- **Scope by data id, `.../<data-id>/blobs`.** Refused. The authority holds one copy per principal and the store is opened once per session for every data id of the app, so a data-id scope would add a segment nothing selects by.
- **Reserve the word `blobs` at the definition boundary.** Refused as redundant: a data id must contain a dot, so the grammar already refuses it, and a reserved-word list is a second guard over one invariant, free to disagree with the first.
- **Keep `databaseName` as an option beside the scope.** Refused. It is the door the unscoped store walked through, and a store the caller can name is a store the caller can name wrong. The one legitimate raw-name open, the claim of `epicenter-blobs`, is a private opener in the same module.
- **Read the scope off `auth.state` in the shell, or thread `principalId` down from the boot node as a prop.** Refused. Both are a second source of truth beside the replica's own stamp, which the opener validated with the same segment rule, and the prop in particular copies a value out of a state that can move underneath a live shell.
- **Kind-first on desktop, `apps/<app-id>/blobs/<principal-id>/`.** Replaced by the app/principal scope above. Device data remains outside the exact blob directory that removal owns.
- **Content-address the bytes so two accounts could share one copy.** Refused by ADR-0148, and impossible here anyway: the desktop recorder mints the id at `start`, before the bytes are final.
- **Sweep `epicenter-blobs` on first open of the scoped store.** Refused by ADR-0351: bytes whose owner cannot be proven are not this account's to delete, and a sweep that runs once on every shipped device cannot be exercised before it ships.
- **Add `kept` to `stat`.** Refused. `packages/server/src/routes/blobs.ts` mounts `POST`, `GET`, and `DELETE` and no `HEAD`, so `stat` would either make a network round trip on a call that reads local metadata, or report the row's `uploadedAt` back to the caller who owns it.
- **A Service Worker serving `/blobs/<id>` from IndexedDB, so `url` returns a plain string.** Refused. It buys the loss of `Disposable` at the cost of a worker registration in the boot path, a fetch handler that must be correct before any media element loads, and a second answer for what a blob URL means on desktop.
- **Collapse `@epicenter/blobs` into `@epicenter/app`.** Refused. `apps/epicenter/src/main.ts` uses `createBunBlobStore` from the Bun host, which never constructs an `Epicenter` handle, and `@epicenter/constants` already imports `BlobId` and `BLOB_ID_ROUTE_REGEX` for its route patterns.
