# 0173. Each row owns at most one write-once immutable blob

- **Status:** Proposed
- **Date:** 2026-07-20 (revised 2026-07-21: the slot is record-wide and only
  the terminal tombstone reaps it; "row" in the title is the table
  interpretation of the universal record slot)
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

Every live record universally owns one latent blob slot, whatever collection
it lives in. The slot is undeclared by Lenses and contains either no bytes or
exactly one finalized immutable byte stream; typed APIs expose it only where
the Lens makes it meaningful (table collections in V1). The record address is
the blob's sole public identity. SHA-256 records the accepted bytes' integrity
and makes publication idempotent; it is not a `BlobId` or another public
address component.

The slot is write-once during the record's life:

```txt
absent + digest A  -> accept A
digest A + A       -> idempotent success
digest A + B       -> refuse or park B
```

Incomplete capture has temporary staging state and no permanent blob identity;
ADR-0172's staging write-order law owns that lifecycle. Finalization hashes
the complete stream before the runtime admits it to a live record. New bytes
require a new record (applications experience this as a new row), followed by
an ordinary non-atomic reference change and deletion of the old one. Multiple
binary assets therefore require multiple records. Epicenter provides no
multi-blob record, replacement-in-place, generic cascade, reference count, or
blob garbage collector beyond ADR-0172's debris sweep.

The terminal tombstone is the only distributed blob deletion. It revokes the
record's scalar state, document, blob slot, and future publication at one
durable address; reversible unset reaps none of them. Physical byte cleanup
may finish later and remains idempotent.

ADR-0178 Lens import uses this same capture and publication law. It preserves
the source record key, so a retry targets the identical destination record. A
locally minted record ordinarily introduces a new live record and publishes its
finalized bytes. At a shared live record, an equal digest is idempotent and a
different digest is refused or parked; import adds no blob replacement or merge
semantics. A destination terminal tombstone refuses the slot. After verified
import, explicit retirement reclaims only the unclaimed replica's physical
identity under ADR-0172's debris rule. Another identity slot never adopts an
unverified stale file and cannot become a target of delayed retirement cleanup.

The private live store may use the digest in a filename or transfer key, but no
physical path is part of logical identity. A portable artifact exposes the
accepted digest as nullable platform state beside the record's scalar payload
and compact document update; an inspection snapshot exposes the same nullable
digest as metadata (ADR-0162). Application fields or documents give the bytes
their filename, media type, and meaning; those citations are not the platform's
membership inventory.

## Consequences

- Blob operations take a record address. No public operation takes a bare
  digest or opaque blob ID.
- Identical bytes owned by different records have independent lifecycles and
  may occupy independent physical files.
- A row with several attachments becomes one parent row plus several ordinary
  asset rows. Those references are non-enforcing and may temporarily leave
  valid orphan asset rows.
- A different digest cannot replace bytes beneath an existing live record.
  This refusal deletes per-member identity, enumeration, revocation,
  convergence, and Backup membership machinery.
- A Backup derives blob membership from live records whose nullable digest is
  present, then requires and verifies exactly one raw byte file for each such
  record. No blob-membership manifest or separate portable blobs relation
  exists.
- Authority publication remains a separate streamed transfer even though the
  blob shares its record's lifecycle.
- Lens import adds no blob-specific transfer protocol. It captures through the
  ordinary destination record operation; retirement destroys the unclaimed
  replica only after verified import.

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
