# 0173. Each row owns at most one write-once immutable blob

- **Status:** Proposed
- **Date:** 2026-07-20
- **Superseded by:** [ADR-0212](0212-a-row-is-a-yjs-type-and-its-prose-is-a-lazily-loaded-document.md) (`Proposed`). Withdrawn: the write-once blob slot, `digest A + B -> refuse or park B`, and the rule that Epicenter provides no replacement-in-place or blob garbage collector. A blob digest becomes an ordinary cell that a later write repoints, orphaning bytes as garbage rather than refusing the write. Also superseded by [ADR-0349](0349-local-blobs-belong-to-the-app-on-this-device.md) at the public operations: `table.blobUrl(rowId)` and `table.writeBlob(rowId, bytes)` are withdrawn along with the rule "No public operation takes a bare digest or opaque blob ID". Blobs are one `epicenter.blobs` namespace on the handle addressed by an opaque `BlobId`, and a row cell holds that id.
- **Supersedes:** [ADR-0148](0148-blobs-use-opaque-identifiers-rather-than-content-hashes.md)
- **Amends:** [ADR-0154](0154-blob-access-is-address-only.md)
- **Relates:** [ADR-0164](0164-scalar-facts-converge-independently-epicenter-refuses-distributed-transactions.md), [ADR-0167](0167-a-portable-epicenter-is-an-identity-free-export-of-one-authority-cut.md), [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md), [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md)

## Context

Opaque blob IDs require a second identity, checksum, collision rule, remote key,
and portable-artifact mapping. Allowing several blobs beneath one row would
remove the opaque ID but preserve another collection with its own membership,
enumeration, deletion, and recovery rules. Rows are already Epicenter's
independently convergent multiplicity primitive.

## Decision

Every live row universally owns one latent blob slot. The slot is undeclared by
Lenses and contains either no bytes or exactly one finalized immutable byte
stream. The row address is the blob's sole public identity. SHA-256 records the
accepted bytes' integrity and makes publication idempotent; it is not a
`BlobId` or another public address component.

The slot is write-once during the row's life:

```txt
absent + digest A  -> accept A
digest A + A       -> idempotent success
digest A + B       -> refuse or park B
```

Incomplete capture has temporary staging state and no permanent blob identity.
Finalization hashes the complete stream before the runtime admits it to a live
row. New bytes require a new row, followed by an ordinary non-atomic reference
change and deletion of the old row. Multiple binary assets therefore require
multiple rows. Epicenter provides no multi-blob row, replacement-in-place,
generic cascade, reference count, or blob garbage collector.

Row deletion is the only terminal distributed blob deletion. It revokes the
row's scalar state, document, blob slot, and future publication at one durable
row address. Physical byte cleanup may finish later and remains idempotent.

First-attachment `Bring local data` uses this same publication law. A locally
minted row ordinarily introduces a new live row and publishes its finalized
bytes. At a shared live row, an equal digest is idempotent and a different
digest is refused or parked; first attachment does not add blob replacement or
merge semantics. A remote terminal row tombstone refuses the slot.
`Discard local data` removes local blob membership and publication obligations
before attachment, then reclaims only the pre-clear physical file identity under
ADR-0172's debris rule. Later hydration of the same row address never adopts an
unverified stale file and cannot make that file a target of delayed cleanup.

### The two doors, added 2026-08-04

This record said blob operations take a row address without naming the
operations. There are exactly two, both on the table that owns the row:

```ts
table.blobUrl(rowId)            // pure, synchronous, a stable URL
table.writeBlob(rowId, bytes)   // the slot law above, applied once
```

`blobUrl` is the row address spelled as a path. It is derivable from the address
*and* parseable back into it, which is the opposite constraint from the internal
filename below and deliberately so: a URL is a public spelling of a public
address, while a filename is an internal surrogate whose one-way derivation is
what forces recovery to start from a SQLite query rather than a directory scan.
The URL is the same on every device; whether the host serves a local file or
fetches from the authority behind it is not the application's business. Bytes
never cross into JavaScript for playback or display, so a four-hour recording
costs an element `src` rather than a buffer.

`writeBlob` is how bytes an application already holds enter a row: an imported
file, an attachment, an image. Recording is the other door onto the same slot,
under the same write-once law. There is no third.

The private live store may use the digest in a filename or transfer key, but no
physical path is part of logical identity. A portable or inspection row exposes
the accepted digest as nullable platform state beside the row's scalar fields
and compact document update. Application fields or documents give the bytes
their filename, media type, and meaning; those citations are not the platform's
membership inventory.

## Consequences

- Blob operations take a row address. No public operation takes a bare digest
  or opaque blob ID.
- Identical bytes owned by different rows have independent lifecycles and may
  occupy independent physical files.
- A row with several attachments becomes one parent row plus several ordinary
  asset rows. Those references are non-enforcing and may temporarily leave
  valid orphan asset rows.
- A different digest cannot replace bytes beneath an existing live row. This
  refusal deletes per-member identity, enumeration, revocation, convergence,
  and Backup membership machinery.
- A Backup derives blob membership from live rows whose nullable digest is
  present, then requires and verifies exactly one raw byte file for each such
  row. No blob-membership manifest or separate portable blobs relation exists.
- Authority publication remains a separate streamed transfer even though the
  blob shares its row's lifecycle.
- First attachment adds no blob-import protocol. `Bring` publishes through the
  ordinary row-addressed obligation; `Discard` clears the unattached slot.

## Considered alternatives

- **Allow zero or more blobs per row.** Rejected because it creates a second
  multiplicity system with per-member identity, enumeration, deletion,
  convergence, and recovery rules. Multiple assets use multiple rows.
- **Use a principal-global content address.** Rejected because independently
  owned rows would share deletion fate or require reference counting.
- **Permit blob replacement beneath one row.** Rejected because it introduces
  another convergent mutable fact. New immutable bytes receive a new row.
- **Keep opaque IDs beside content digests.** Rejected because the mapping
  recreates the identity and integrity machinery this decision removes.
- **Embed blob bytes in scalar JSON, Yjs updates, or SQLite BLOB columns.**
  Rejected because large immutable streams require different bounds and IO.
