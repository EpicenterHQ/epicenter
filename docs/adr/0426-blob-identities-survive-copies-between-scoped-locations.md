# 0426. Blob identities survive copies between scoped locations

- **Status:** Proposed
- **Date:** 2026-09-22
- **Unbuilt:** Store-owned blob access, same-ID remote publication and copy, verified retry equality, and application reference migration. The physical paths below already exist through the current standalone openers.
- **Amends:** [ADR-0089](0089-the-blob-store-is-a-presigned-s3-kernel-and-the-bucket-is-its-only-index.md) at content-addressed keys, mandatory presigned transfer, and its fixed size doctrine; [ADR-0090](0090-the-blob-layer-stays-plaintext-confidentiality-belongs-to-the-encrypting-consumer.md) at its content-hash addressing assumption only; [ADR-0091](0091-blobs-trade-a-file-for-a-durable-content-addressed-url-documents-are-the-only-manifest.md) at URL-as-identity; [ADR-0092](0092-identity-is-the-partition.md) at blob route/key grammar; [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) and [ADR-0404](0404-the-opened-account-owns-application-local-storage.md) at local blob addressing only.

## Context

`id` on a blob opener selects an application namespace. `blobId` selects one
object inside it. Conflating these IDs makes a copy look like it must either
inherit the source namespace or create a different object. Current upload does
the latter: the server mints another ID and the application saves its URL.

A recording, an uploaded copy, and a downloaded copy can retain one identity
without sharing ownership, deletion, or automatic synchronization.

## Decision

**A copy preserves the complete BlobId and bytes; each handle fixes a location.**

A BlobId remains `blob_`, 21 random lowercase alphanumeric characters, a dot,
and a lowercase alphanumeric extension of 1 to 10 characters. It contains no
namespace, account, path, URL, or row ID. `add` creates a new identity;
`copyFrom` preserves an existing identity. Conversion or editing creates new
bytes under a new ID. An extension declares format; it is not content validation.

A namespace uses the existing validated application-ID grammar and is selected
by the owning store's definition ID. An application can open several stores
with different definitions. `local.blobs` captures device-local placement;
`personal.blobs` captures the store's account and remote placement. Future
`shared.blobs` captures a shared owner, with authorization and physical paths
still to be designed. These names select storage; they grant no authority.

| Location | Logical address | Physical storage |
| --- | --- | --- |
| Browser local | Origin/profile storage, namespace, BlobId | IndexedDB `epicenter/<namespace>/device/no-account/blobs`, object store `blobs`, key `blobId` |
| Desktop local | Selected data root, namespace, BlobId | `<dataRoot>/apps/<namespace>/device/no-account/blobs/<blobId>` |
| Remote | Server authority, authenticated principal, namespace, BlobId | `principals/<principalId>/apps/<namespace>/blobs/<blobId>` inside that deployment's configured object-storage bucket |

`<account>` in conversational descriptions of the remote path means the captured
account's `principalId`, not its email, bearer token, or an Account object. The
server authority selects the deployment and bucket; it is not another segment
inside this remote key. Principal segments use the server's existing encoding.
The remote transport currently uses an owner-pinned HTTP locator:
`<server>/api/apps/<namespace>/principals/<principalId>/blobs/<blobId>`.
A playback grant or temporary URL is a different value from this storage address.

Local uses the literal `device/no-account` partition even when signed in.
Account replacement neither moves local bytes nor opens another local partition.
Historical account-local data is not adopted or erased. The lower-level browser
adapter's optional account parameter is not the public LocalBlobs contract.

Browser records contain `{ id, bytes, size }`; the writer derives size and
commits the record and its index together. Desktop objects remain ordinary flat
files, with no per-object directory or metadata sidecar. Rust publication, Bun
reads, and native transfers must resolve the same data root and path grammar.
WebViews use host files rather than a second persistent browser copy. These
paths describe existing storage, not authorization to rename or migrate it.

For example, with shortened IDs:

```text
Device: apps/so.epicenter.capture/device/no-account/blobs/blob_abc.wav
Server: principals/alice/apps/so.epicenter.library/blobs/blob_abc.wav
Device: apps/so.epicenter.library/device/no-account/blobs/blob_abc.wav
```

These can hold identical copies despite different namespace and location scopes.
`destination.copyFrom(source, blobId)` selects both scopes from the actual
handles. It does not accept a replacement destination BlobId or derive either
namespace from the other.

### Identity is not global proof of equality

Remote publication addresses the destination object by its chosen BlobId.
`add` mints that ID before publication; `copyFrom` supplies the source ID.
The current collection POST that assigns a fresh ID cannot implement copying.
Choose and verify the collision/equality protocol before claiming retry safety.
If publication may have succeeded but acknowledgment is lost, preserve the ID
and destination scope in the operation outcome so callers can reconcile it.
This applies to new-byte creation as well as copying.

Random generation makes accidental collision unlikely. Each physical store
enforces key uniqueness within its scope; there is no global ID registry.
Copies through the supported API preserve bytes. Equal opaque strings obtained
from unrelated or untrusted locations do not prove equal content and grant no
access. Matching size or extension does not prove equality either.

A destination never overwrites an occupied ID. A repeated copy may report
success only after establishing that the existing bytes equal the source; if
equality cannot be established, it reports an explicit conflict. Atomic
publication must enforce this under concurrent writers. A trusted, verified
content digest may be an internal mechanism; this decision does not change
public IDs to hashes or promise deduplication of separately added equal inputs.
An existing local copy cannot authenticate an unrelated remote reference merely
because their IDs match. Applications and transport must retain the reference's
scope and trust context.

### References name enough scope to find the placement

A row can store just a BlobId when its enclosing application/store supplies the
namespace and remote authority/principal. Otherwise a credential-free placement
reference must retain the missing scope. Do not infer a former upload's owner
from whoever is currently signed in. One ID can have placements under several
accounts; knowledge of one does not discover or authorize the others.

Local and Personal need not declare the same recording fields. A Personal row
containing only saved text needs no audio reference. If it references audio in
its own `personal.blobs`, that ID names a remote placement, not a promise that
the reader's device has a local copy. Mapping a Local row into Personal must
deliberately omit local-only fields or publish and reference the intended bytes.
Nesting blobs does not perform that mapping or transfer.

Removing a second remote blob identity does not automatically remove all remote
location metadata. It removes a post-copy row write only when the destination
scope was already known. Presence is an observation, not a permanent property of
the ID. An old upload receipt cannot prove the object still exists.

## Consequences

Each placement has independent retention and deletion. Deleting a local copy
does not erase a remote copy; a later explicit copy can recreate it. Row deletion
and handle closure do not delete bytes. No distributed delete, cache eviction,
background synchronization, reference counting, or global liveness index follows.
Local copies remain accessible after sign-out and are subject to device storage
loss. These limits must not be described as archival or revocable remote access.

Same-ID transfer replaces fresh remote identity creation. The public contract is
in [ADR-0372](0372-local-and-remote-blobs-open-independently.md); presentation is
in [ADR-0427](0427-opening-a-blob-acquires-presentation-without-retaining-a-copy.md).
Current code still mints fresh remote IDs. Its 25 MiB buffered upload limit is
an implementation boundary to measure and replace deliberately, not a claim of
large-video support or a permanent identity rule. No data migration is authorized
by this record.

## Considered alternatives

- Encode namespace/account into BlobId: turns a placement change into an identity
  change and duplicates the scope already held by handles.
- Mint a new ID on every copy: requires identity mappings and creates duplicate
  objects after uncertain transfer acknowledgments.
- Treat equal random IDs as proof of equal bytes: permits conflicting publishers
  to substitute content across independently writable locations.
- Global content-addressed storage: adds hashing and cross-owner policy to a
  workflow that only requires explicit immutable copies.
- Collapse the physical paths for aesthetics: opens different storage and needs a
  separate data migration without improving the public handle contract.
