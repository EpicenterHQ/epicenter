# 0161. Each person has one Epicenter replicated on each adapter boundary

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0151](0151-local-workspace-stores-use-owner-first-directories.md) and [ADR-0143](0143-account-open-never-consumes-device-data.md)
- **Amends:** [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md) by removing workspaces beneath the principal authority
- **Amended by:** [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md) (Backup and Restore above the replica boundary) and [ADR-0177](0177-each-store-owner-persists-records-in-one-wide-interned-crash-state-relation.md) (supersedes the schema-wide coordinate-layout evidence enumeration)

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

A local replica begins unattached and works offline. Authentication first
resolves the principal. Before the first successful attachment permanently
binds the replica to that principal, a person whose unattached replica contains
logical state or durable obligations, including tombstones, makes one
whole-replica choice:

```txt
Bring local data
  permanently attach this replica, then converge its existing rows, values,
  deletions, documents, and blobs through the ordinary plane-specific laws

Discard local data
  atomically clear this replica's logical state and obligations while recording
  the permanent attachment, then hydrate the principal's existing Epicenter
```

An empty replica attaches directly. Both paths end with the same single
attached replica. `Bring` converges into the remote authority but never replaces
it as a whole. `Discard` leaves the remote authority unchanged. Neither path is
Restore, and neither path creates a second local store.

The choice is binary and available only before the first attachment. `Discard`
is destructive at whole-replica scope. `Bring` retains local state and
authorizes ordinary convergence, including its ordinary overwrites and
deletions. There is no per-row preview, selective migration, keep/replace/merge
menu, or later adoption mode. This is not Device-to-Account adoption between
two local stores: one unattached replica either retains or clears its own
contents before it gains a synchronization attachment.

A replica never silently changes principals. Signing out removes credentials
and pauses synchronization but leaves the attachment and local data intact.
Signing in as another principal requires a fresh local replica. Clearing an
attached replica's data never changes its attachment. There is no profile
catalog, owner switch, Add/Delete/Keep adoption mode, parallel Device and
Account stores, or automatic account merge choice.

The server derives the authority solely from the authenticated principal. The
self-hosted deployment resolves its one principal in the same way. No catalog,
database inventory, alias, grant, rekey map, or per-database lifecycle exists.

The private SQLite schema has one format/version root plus relations for
per-record lane state, replica progress, pending local work, and document
updates as needed by the adapter. Large record-owned blob bytes live as raw
files under the same adapter lifecycle owner. Application data addresses are
the record triple: a namespace key, a collection key, and a record key; no
address kind exists. A namespace never changes the whole-replica boundary.
Private relation names and layouts are adapter implementation details, not
native-reader contracts.

## Consequences

- Opening, clearing, exporting, deleting, and attaching apply to the whole
  Epicenter. There is no per-application or per-database variant.
- A signed-in device downloads the whole Epicenter. Selective replication must
  not return without a measured product need because it would reintroduce a
  durable scope axis.
- Every attached adapter pays the storage and transfer cost of the whole
  Epicenter. The implementation must exercise this trade at the representative
  aggregate scalar target below. The target is not a hard product limit, a
  universal browser-storage guarantee, or a wire constant.
- Refusing partial replication deletes query subscriptions, replication
  buckets, authorization-aware fanout, and per-replica scope state.
- First sign-in can converge two independently edited histories. Globally unique
  row IDs make the ordinary case a union; the synchronization conflict rules
  still decide same-address edits, value writes, and Yjs documents.
- Choosing `Bring` authorizes local live scalar values to replace conflicting
  remote live values through ordinary authority ordering. Disjoint row-field
  patches compose, exact Yjs state joins, write-once blobs use their ordinary
  acceptance law, and remote terminal row tombstones remain final. A brought
  row tombstone is an ordinary offline deletion and terminally deletes a shared
  remote live row.
- Choosing `Discard` can leave orphan raw blob files after its logical
  transaction. They are removable storage debris, not live product state, and
  the adapter reclaims them idempotently under ADR-0172.
- Switching accounts is intentionally less convenient than maintaining a
  hidden multi-profile store. The refusal deletes the second ownership model.

## Acceptance evidence

Before this ADR becomes Accepted, maintained evidence must exercise the real
replica and authority workflows on their supported production runtimes. The
evidence records whether the required proof is ready for review. It never
selects, ranks, or recommends a physical layout; ADR-0177 makes that choice
under its named acceptance charters.

The same evidence must prove the first-attachment boundary:

- `Bring` preserves locally durable scalar, document, and blob obligations
  across process failure and drains them only through their ordinary authority
  acceptance operations;
- independently minted rows form a union, direct live scalar collisions follow
  ADR-0163, exact Yjs state follows ADR-0174, and a remote terminal row
  tombstone cannot be resurrected by any plane;
- `Discard` commits the logical clear and permanent attachment together before
  hydration begins, while raw-file cleanup may finish idempotently afterward;
- during `Discard`, a crash exposes either the intact unattached replica or the
  fully cleared and attached logical replica, never an attached replica that
  retains pre-Discard obligations;
- during `Bring`, attachment may commit before ordinary drains finish, and every
  retained obligation survives a crash and resumes draining; and
- the choice is available only while the replica is nonempty and unattached. A
  cancelled or failed attempt may present it again; it never returns after
  attachment commits.

The representative normal stress target contains exactly 1,000,000
final-present scalar addresses whose versioned scalar-fields-and-values
benchmark proxy totals exactly 536,870,912 bytes. These are aggregate properties
of one corpus, approximately 536.9 bytes per final-present address on average.
They do not permit 512 MiB per address, describe one million 512 KiB rows, or
choose ADR-0163's independent maximum encoded fact size.

The proxy includes structured addresses, row fields, and value content. It
excludes terminal row tombstones, reversible value absences, sequences, wire
framing, SQLite pages, documents, blob digests, and raw blob bytes. The target is
therefore representative present-state stress evidence, not a bound on total
replica size or lifetime growth. The
[maintained benchmark contract](../../scripts/benchmarks/scalar-facts-layout/README.md)
owns the proxy encoding, fixture ratios, physical measurements, and outcome
vocabulary; it reports current-fact count and current protocol-fact bytes
separately.

Browser capacity remains conditional. Physical iOS Safari and physical Android
Chrome must complete a maintained floor of 250,000 final-present addresses and
128 MiB of the same proxy. The 1,000,000-address, 512 MiB profile runs where
measured storage availability admits it. Honest quota refusal must preserve the
previous committed prefix and durable progress, but it does not prove capacity.
Private or incognito storage supplies negative refusal evidence only.

The physical layout selection and its evidence charters are owned by ADR-0177,
which selects the wide interned record row as the Proposed candidate with the
split layout as its sole runner-up. This ADR's representative envelope and
mobile floors remain the fixture those charters measure against; nothing in
this ADR's evidence selects a layout.

## Considered alternatives

- **Named databases inside one store.** Rejected because inventory, lifecycle,
  routes, captures, and identity remain database-scoped despite every replica
  synchronizing all of them.
- **Separate Device and Account stores.** Rejected because sign-in then needs an
  adoption or merge product with two simultaneous owners.
- **Always bring unattached local data.** Rejected because first sign-in would
  irreversibly converge anonymous or scratch data without the person's consent.
  One pre-attachment whole-replica clear preserves a single owner without
  creating an adoption system.
- **Offer per-item keep, replace, or merge choices.** Rejected because it creates
  migration inventory, conflict presentation, and a second set of convergence
  semantics. `Bring` uses the ordinary plane laws; `Discard` clears the whole
  unattached replica.
- **One physical file literally shared by every app and browser origin.**
  Rejected because sandbox and origin isolation make that impossible; adapters
  may replicate the same logical Epicenter without changing its public model.
