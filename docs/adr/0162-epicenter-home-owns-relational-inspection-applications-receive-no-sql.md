# 0162. Epicenter Home owns relational inspection; applications receive no SQL

- **Status:** Accepted
- **Date:** 2026-07-20 (revised 2026-07-21: the live owner-mediated SQL session
  is replaced by point-in-time inspection snapshot artifacts)
- **Supersedes:** [ADR-0157](0157-read-only-sql-exposes-one-schema-opaque-row-relation.md)
- **Amends:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md)
- **Relates:** [ADR-0167](0167-a-portable-epicenter-is-an-identity-free-export-of-one-authority-cut.md), [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md), [ADR-0177](0177-replica-and-authority-owners-use-role-specific-wide-record-relations.md)

## Context

Applications need typed local reads. People and agents also need to inspect one
Epicenter as familiar tables and issue ad hoc relational queries across them.
Giving every application a SQL escape hatch would couple product code to
private storage and create a second untyped application API.

An earlier revision of this decision gave Epicenter Home a live SQL session
executed by the store owner over TEMP views, with one-session exclusivity and
busy refusals. Excavation showed that session was never implemented, and the
lane-based record store removed its cheap foundation: visible state is now a
fold of confirmed, sealed, and pending lanes with a parked overlay and
tombstone suppression. That fold is not expressible in built-in SQL
(`json_patch` is RFC 7386 MergePatch, which conflates null with removal), and
bun:sqlite exposes no user-defined-function API. Honest live SQL would need
either raw lane views that push the fold onto every query or a materialized
visible-state column that ADR-0177 refuses. Those facts sharpened the product
question, but the deciding observation is about ownership: the SQL job Home
actually owes is analysis over a coherent state, and analysis is honest at a
point in time. Live jobs are typed jobs.

## Decision

Application-facing `Epicenter` APIs expose typed collections only. They expose
no `sql()` method, raw SQLite connection, query builder, projection DTO, CTE
injection, inspection session, TEMP view, persistent application view, or
native-reader contract. Binding any number of application Lenses creates no SQL
state.

Epicenter Home owns relational inspection as a trusted host capability, and
inspection means capture: Home asks the store owner for a point-in-time
**inspection snapshot**, an inert SQLite artifact, and runs SQL against that
artifact in its own context. Nothing executes SQL on the live store's
connection on anyone's behalf, and no one receives the private live file.

`captureSnapshot` is one owner command gated at the trusted host or origin
boundary, exactly where the previous revision gated its session. The owner
builds the artifact from one read transaction over its records: the visible
scalar state fold happens in the owner's code at capture time. On desktop,
Home then opens a separate read-only SQLite handle on the artifact file. In a
browser, the owner builds the artifact beside its private file and transfers
the inert bytes to Home; Home queries them in its own sandbox and never opens
a second OPFS connection. The capture command is the security boundary; the
querying surface holds only bytes it owns.

Every inspection snapshot self-identifies. Its `_epicenter_artifact` metadata
row (ADR-0167) declares `kind = 'snapshot'`, the format version, the source
authority lifetime, and the source authority's captured `after_sequence`. A snapshot has no apply meaning
and no Restore meaning, structurally and permanently: it is never accepted as
a portable Backup, a Proposal, or any other input.

The snapshot's lossless reserved relation is:

```sql
_epicenter_records(
  namespace,
  collection,
  record_key,
  payload_json,
  document_revision,
  document_accepted_revision,
  document_byte_length,
  blob_sha256,
  blob_accepted_sha256
)
```

One relation, because durable storage carries no collection kind: a kindless
capture cannot split records into row and value relations without a Lens,
which would break the no-Lens-installed promise. The relation preserves every
payload byte, including unknown and nonconforming data, with no Lens
installed.

Snapshots are lightweight. The document columns are metadata: the record-local
and authority-accepted revisions and the encoded chain size in bytes (never
document content). The blob columns record local and authority-accepted
digests. Publication obligations are derived by comparing each pair. A
snapshot never contains a composed
document cell or blob bytes, so a missing
value can never lie about document existence and capture needs no cross-file
cut. Complete document state and blob bytes belong to the portable Backup
(ADR-0167, ADR-0170). The rare single-document export job is served by an
explicit typed per-record export operation (ADR-0174), not by SQL.

Selecting a Lens at capture time writes one explicit-column SQL view per
declared collection into the artifact, named by the Lens's durable local key,
projecting from `_epicenter_records` with base JSON type guards. Views, not
copied tables: the raw relation stays the one truth inside the artifact, and
JSON1 is ubiquitous in consumers. The owner quotes generated identifiers,
reserves the `_epicenter_` prefix and SQLite internal names, and refuses a
capture whose declared collection keys collide under SQLite's ASCII
case-insensitive identifier comparison. Snapshot metadata records which Lens,
if any, generated the views.

A snapshot is stale the moment it is captured; refresh is recapture. That is
the honest consistency story: one owner read transaction, one stated authority
feed position, rather than a live session in which several statements observe
intervening writes. Because the artifact is inert bytes, there is no session
lifecycle, no one-session exclusivity, no busy refusal, and no
never-while-stepping discipline; concurrent captures and concurrent queries
are ordinary file operations.

Live jobs remain typed. Home's table browser uses the classified traversal
(ADR-0175), sync status and parked work use the address-scoped observation
surface (ADR-0163, ADR-0174), and none of them speak SQL. Deleting the live
SQL session deletes none of those surfaces and does not reduce what Home can
show live; it removes only ad hoc SQL from the live connection.

## Consequences

- Typed application reads may use private SQL and the canonical address index
  internally. Additional index-backed reads require the separately owned
  decision described by ADR-0176.
- Home offers a table browser live and ad hoc SQL over snapshots, without
  granting applications SQL or stabilizing the private live schema. The first
  release needs a minimal way to open or query the artifact, not a polished SQL
  console.
- The owner's inspection surface shrinks from a SQL executor with session
  lifecycle to one capture command.
- Long analytical queries run in Home's context and can never stall the
  owner's serialized write and synchronization path.
- Agents get a durable, shareable query artifact whose provenance and
  watermark are recorded in the artifact itself.
- Raw queries always address honest namespace, collection, and record key
  coordinates, including unknown and nonconforming data, with no Lens
  installed.
- Freshness is explicit: results are a stale point-in-time cut, with the source
  authority feed position recorded as provenance, and refresh is recapture. A future live inspection mode would be a separately earned
  capability and must never imply snapshot repeatability.
- Browser Home never opens a second OPFS connection; capture reuses the one
  owner and transfers bytes.

## Considered alternatives

- **The live owner-mediated SQL session (the previous revision).** Rejected
  because the lane store makes honest live SQL expensive (the visible-state
  fold is not built-in SQL, and the primary desktop owner has no
  user-defined-function API), because a long statement stalls every mutation
  behind the owner's serialized connection, and because its session
  exclusivity, TEMP view lifecycle, and busy refusals existed only to
  compensate for putting an interactive surface inside the one live
  connection. Analysis, the actual SQL job, is honest at a point in time.
- **A materialized visible-state column to keep live SQL cheap.** Rejected by
  ADR-0177: a derived column maintained by every lane transition is a standing
  corruption class whose only consumer was this surface.
- **Kind-split raw relations (`_epicenter_rows` and `_epicenter_values`).**
  Rejected because storage carries no collection kind; a kindless capture
  cannot losslessly split unknown records without a Lens.
- **Snapshots with composed document cells.** Rejected because per-record Yjs
  composition makes capture expensive, and a NULL cell would be ambiguous
  between no document and not composed. Metadata columns cannot lie; Backup
  carries the real composed state.
- **Copied friendly tables instead of views inside the artifact.** Rejected
  because copied rows duplicate truth inside one file; views keep the raw
  relation authoritative. (The prototype-gated Proposal candidate is expected
  to make the opposite choice because it is an editing surface; its own ADR
  waits for its prototype.)
- **Expose the private live SQLite file.** Rejected because a physical adapter
  layout is not the logical Epicenter and may change independently.
- **Read-only `sql()` guarded by parsing or `EXPLAIN`.** Rejected because it is
  still a second application query language over private storage.
- **No relational inspection at all.** Rejected because trusted human and
  agent inspection is a core Epicenter Home responsibility.
