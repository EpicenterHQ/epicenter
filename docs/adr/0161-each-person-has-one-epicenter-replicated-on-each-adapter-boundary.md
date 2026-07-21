# 0161. Each person has one Epicenter replicated on each adapter boundary

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0151](0151-local-workspace-stores-use-owner-first-directories.md) and [ADR-0143](0143-account-open-never-consumes-device-data.md)
- **Amends:** [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md) by removing workspaces beneath the principal authority

## Context

Per-workspace files and the later named-database proposal both preserve a
storage boundary the product no longer has. A person expects the same Epicenter
on every signed-in device. SQLite files, browser origins, processes, and server
actors are physical isolation boundaries, not additional product data owners.

## Decision

One principal owns one logical Epicenter. The authority stores that entire
Epicenter in one SQLite database. Each native installation, browser origin, or
other adapter isolation boundary stores one complete scalar address universe in
one local SQLite replica. It persists document state and blob bytes that are
created or opened there. Every replica synchronizes the person's whole scalar
Epicenter, publishes its durable document and blob work automatically, and
hydrates remote documents and blobs lazily. The authority owns the complete
accepted document and blob holdings.

"One replica per device" is product shorthand, not a physical guarantee.
Browsers cannot share storage across origins, and separate OS profiles or
sandboxed applications may also require separate local replicas. These are
adapter constraints. They never add an application, workspace, or database ID
to a durable data address.

A local replica begins unattached and works offline. Its first successful
sign-in permanently attaches it to the resolved principal and converges its
existing rows, values, deletions, documents, and blobs with that principal's
Epicenter. This is not Device-to-Account adoption between two local stores:
the same local replica gains a synchronization attachment.

A replica never silently changes principals. Signing out removes credentials
and pauses synchronization but leaves the attachment and local data intact.
Signing in as another principal requires a fresh local replica or explicit
destructive clearing. There is no profile catalog, owner switch, Add/Delete/Keep
adoption mode, parallel Device and Account stores, or automatic account merge
choice.

The server derives the authority solely from the authenticated principal. The
self-hosted deployment resolves its one principal in the same way. No catalog,
database inventory, alias, grant, rekey map, or per-database lifecycle exists.

The private SQLite schema has one format/version root plus relations for current
scalar state, replica progress, pending local work, and row-document updates as
needed by the adapter. Large row-owned blob bytes live as raw files under the
same adapter lifecycle owner. Application data addresses contain an address kind,
namespace key, table or value key, and, for rows, a row ID. A namespace never
changes the whole-replica boundary. Private relation names and layouts are
adapter implementation details, not native-reader contracts.

## Consequences

- Opening, clearing, exporting, deleting, and attaching apply to the whole
  Epicenter. There is no per-application or per-database variant.
- A signed-in device downloads the whole Epicenter. Selective replication must
  not return without a measured product need because it would reintroduce a
  durable scope axis.
- Every attached adapter pays the storage and transfer cost of the whole
  Epicenter. The implementation must prove this trade at a conformance envelope
  of 1,000,000 live scalar addresses and 512 MiB of canonical encoded logical
  state. This is a design and test envelope, not a hard product limit or a wire
  constant.
- Refusing partial replication deletes query subscriptions, replication
  buckets, authorization-aware fanout, and per-replica scope state.
- First sign-in can converge two independently edited histories. Globally unique
  row IDs make the ordinary case a union; the synchronization conflict rules
  still decide same-address edits, value writes, and Yjs documents.
- Switching accounts is intentionally less convenient than maintaining a
  hidden multi-profile store. The refusal deletes the second ownership model.

## Considered alternatives

- **Named databases inside one store.** Rejected because inventory, lifecycle,
  routes, captures, and identity remain database-scoped despite every replica
  synchronizing all of them.
- **Separate Device and Account stores.** Rejected because sign-in then needs an
  adoption or merge product with two simultaneous owners.
- **One physical file literally shared by every app and browser origin.**
  Rejected because sandbox and origin isolation make that impossible; adapters
  may replicate the same logical Epicenter without changing its public model.
