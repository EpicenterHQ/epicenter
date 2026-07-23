# 0161. Each person has one Epicenter replicated on each adapter boundary

- **Status:** Proposed
- **Date:** 2026-07-20
- **Supersedes:** [ADR-0151](0151-local-workspace-stores-use-owner-first-directories.md) and [ADR-0143](0143-account-open-never-consumes-device-data.md)
- **Amends:** [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md) by removing workspaces beneath the principal authority
- **Amended by:** [ADR-0170](0170-one-live-epicenter-has-sealed-backups-and-restore-creates-a-fresh-authority-lifetime.md) (Backup and Restore above the replica boundary), [ADR-0177](0177-replica-and-authority-owners-use-role-specific-wide-record-relations.md) (supersedes the schema-wide coordinate-layout evidence enumeration), and [ADR-0178](0178-replica-identity-is-immutable-and-sign-in-selects-a-replica.md) (withdraws the mutable first-attachment model; replica identity is immutable, sign-in selects a replica, and import is explicit)

## Context

Per-workspace files and the later named-database proposal both preserve a
storage boundary the product no longer has. A person expects the same Epicenter
on every signed-in device. SQLite files, browser origins, processes, and server
actors are physical isolation boundaries, not additional product data owners.

## Decision

One principal owns one logical Epicenter. The authority stores that entire
Epicenter in one SQLite database. Each local replica stores one complete
scalar address universe in one local SQLite store and persists document state
and blob bytes that are created or opened there. An adapter isolation
boundary (a native installation, browser origin, or similar) holds one
replica per identity: one unclaimed replica plus one replica per account
that has signed in there, each physically separate
([ADR-0178](0178-replica-identity-is-immutable-and-sign-in-selects-a-replica.md)). Every replica synchronizes the person's whole scalar
Epicenter, publishes its durable document and blob work automatically, and
hydrates remote documents and blobs lazily. The authority owns the complete
accepted document and blob holdings.

"One replica per device" is product shorthand, not a physical guarantee.
Browsers cannot share storage across origins, and separate OS profiles or
sandboxed applications may also require separate local replicas. These are
adapter constraints. They never add an application, workspace, or database ID
to a durable data address.

Replica identity is immutable and written once at creation
([ADR-0178](0178-replica-identity-is-immutable-and-sign-in-selects-a-replica.md)):
a replica is permanently unclaimed or permanently owned by one principal.
Authentication selects and authorizes the matching account replica; it never
binds, rebinds, clears, or converges anything. The unclaimed replica works
offline forever and never synchronizes. Data leaves it only through the
explicit, user-confirmed Lens import that ADR-0178 defines, and it disappears
only through explicit retirement after verified import.

A replica never changes principals. Signing out removes synchronization
authority but leaves identity and local data intact. Signing in as another
principal opens that principal's own replica. There is no profile catalog,
owner switch, Add/Delete/Keep adoption mode, or automatic account merge
choice.

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

- Opening, clearing, exporting, deleting, and retiring apply to the whole
  Epicenter. There is no per-application or per-database variant.
- A signed-in device downloads the whole Epicenter. Selective replication must
  not return without a measured product need because it would reintroduce a
  durable scope axis.
- Every account replica pays the storage and transfer cost of the whole
  Epicenter. The implementation must exercise this trade at the representative
  aggregate scalar target below. The target is not a hard product limit, a
  universal browser-storage guarantee, or a wire constant.
- Refusing partial replication deletes query subscriptions, replication
  buckets, authorization-aware fanout, and per-replica scope state.
- Explicit import can converge independently edited records. Globally unique
  record keys make the ordinary case a union; the synchronization conflict
  rules still decide same-address edits, value writes, and Yjs documents.
  Imported writes replace conflicting remote live values through ordinary
  authority ordering, and remote terminal row tombstones remain final.
- Retiring the unclaimed replica removes its whole store; raw blob files that
  outlive a logical clear are removable storage debris, not live product
  state, and the adapter reclaims them idempotently under ADR-0172.
- Switching accounts opens a different replica and pays its full storage
  cost. This is intentionally less convenient than a hidden shared store; the
  refusal deletes the second ownership model.

## Acceptance evidence

Before this ADR becomes Accepted, maintained evidence must exercise the real
replica and authority workflows on their supported production runtimes. The
evidence records whether the required proof is ready for review. It never
selects, ranks, or recommends a physical layout; ADR-0177 makes that choice
under its named acceptance charters.

The same evidence must prove the immutable-identity boundary
([ADR-0178](0178-replica-identity-is-immutable-and-sign-in-selects-a-replica.md)):

- identity written at creation survives reopen, and opening a store with a
  different identity fails without mutating the store;
- an unclaimed replica never synchronizes, regardless of worker takeover or
  process restart;
- an account replica's durable obligations recorded without a carrier survive
  crash and drain through ordinary acceptance operations on the next
  carrier-bearing open;
- independently minted rows form a union, direct live scalar collisions follow
  ADR-0163, exact Yjs state follows ADR-0174, and a remote terminal row
  tombstone cannot be resurrected by any plane, including by import;
- a repeated or crash-resumed import rewrites identical records rather than
  duplicating them; and
- retirement refuses while any runtime holds the unclaimed replica and
  removes the whole store afterward, with raw-file cleanup idempotent.

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
[ADR-0177 acceptance charters](0177-replica-and-authority-owners-use-role-specific-wide-record-relations.md)
own the physical measurements that exercise this proxy; the retired benchmark
matrix's retained run under `docs/benchmarks/scalar-facts-layout/` remains
historical evidence about its own fixture, reporting current-fact count and
current protocol-fact bytes separately.

Browser capacity remains conditional. Physical iOS Safari and physical Android
Chrome must complete a maintained floor of 250,000 final-present addresses and
128 MiB of the same proxy. The 1,000,000-address, 512 MiB profile runs where
measured storage availability admits it. Honest quota refusal must preserve the
previous committed prefix and durable progress, but it does not prove capacity.
Private or incognito storage supplies negative refusal evidence only.

The physical layout selection and its evidence charters are owned by ADR-0177,
which selects role-specific wide interned record rows and records split as the
measured rejected replica candidate. This ADR's representative envelope and
mobile floors remain the fixture those charters measure against; nothing in
this ADR's evidence selects a layout.

## Considered alternatives

- **Named databases inside one store.** Rejected because inventory, lifecycle,
  routes, captures, and identity remain database-scoped despite every replica
  synchronizing all of them.
- **Separate Device and Account stores.** Originally rejected because sign-in
  would need an adoption product with two simultaneous owners. ADR-0178
  reverses this: identity-separated replicas coexist, and no adoption product
  exists because sign-in only selects and import is explicit and optional.
- **Always bring unattached local data.** Rejected because first sign-in would
  irreversibly converge anonymous or scratch data without the person's
  consent. This rejection stands and is the reason mutable attachment was
  withdrawn.
- **Offer per-item keep, replace, or merge choices.** Originally rejected in
  favor of whole-replica `Bring`/`Discard`. ADR-0178 reopens it deliberately:
  selection is explicit, Lens-shaped, and user-confirmed, and convergence
  still uses only the ordinary plane laws.
- **One physical file literally shared by every app and browser origin.**
  Rejected because sandbox and origin isolation make that impossible; adapters
  may replicate the same logical Epicenter without changing its public model.
