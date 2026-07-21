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
  Epicenter. The implementation must prove this trade at the aggregate scalar
  conformance envelope below. The envelope is a design and test target, not a
  hard product limit, a universal browser-storage guarantee, or a wire constant.
- Refusing partial replication deletes query subscriptions, replication
  buckets, authorization-aware fanout, and per-replica scope state.
- First sign-in can converge two independently edited histories. Globally unique
  row IDs make the ordinary case a union; the synchronization conflict rules
  still decide same-address edits, value writes, and Yjs documents.
- Switching accounts is intentionally less convenient than maintaining a
  hidden multi-profile store. The refusal deletes the second ownership model.

## Acceptance evidence

Before this ADR becomes Accepted, maintained evidence must prove whole-replica
scalar behavior across every supported owner and runtime pairing. Evidence may
classify whether that proof is ready for ADR review, but it never chooses a
physical layout. The layout remains an ADR decision.

The normal scalar profile contains exactly 1,000,000 final-present scalar
addresses whose encoded present scalar logical state totals exactly 536,870,912
bytes under a named, versioned benchmark encoding. These are simultaneous
aggregate properties of one corpus, approximately 536.9 bytes per final-present
address on average. They do not permit 512 MiB per address, do not describe one
million 512 KiB rows, and do not choose ADR-0163's independent maximum encoded
fact size.

Until ADR-0167's portable round-trip freezes the canonical logical encoding,
evidence labels this quantity as a logical-state proxy and reports current
protocol-fact bytes separately. Terminal row tombstones, reversible value
absences, sequences, wire framing, SQLite pages, WAL bytes, documents, and raw
blob bytes do not enter the 512 MiB numerator.

The maintained profiles are:

| Profile                    | Corpus                                      | Role                                                        |
| -------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| PR smoke                   | 10,000 final-present addresses and 5 MiB     | Runs on every change and never qualifies a layout           |
| Physical mobile floor      | 250,000 final-present addresses and 128 MiB  | Required on physical iOS Safari and Android Chrome          |
| Conditional normal profile | 1,000,000 final-present addresses and 512 MiB | Required where measured storage availability admits it     |
| Desktop stress             | 2,000,000 final-present addresses and 1 GiB  | Informational only                                          |
| Private or incognito       | No capacity target                           | Negative persistence and refusal evidence only              |

The conditional normal profile may report `not-admitted` when measured storage
availability cannot cover the peak ceiling. That result proves honest refusal
and recovery, not capacity. The physical mobile floor cannot use
`not-admitted` as a passing capacity result.

The required owner and runtime matrix is:

| Owner               | Runtime evidence                                      |
| ------------------- | ----------------------------------------------------- |
| Local replica       | Bun with native SQLite                                |
| Local replica       | Browser OPFS SQLite in current Chromium               |
| Local replica       | Physical iOS Safari                                   |
| Local replica       | Physical Android Chrome                               |
| Principal authority | Bun with native SQLite for the self-hosted deployment |
| Principal authority | Cloudflare Durable Object SQLite in workerd           |

Playwright WebKit is useful conformance evidence, but it does not substitute
for physical Safari qualification. Each applicable cell covers the owner's
real workflow, not only confirmed-fact reads. Replica evidence includes
acquisition, monotonic prefix installation, pending-intent overlays, point
reads, complete traversal through private pages, tombstone-driven document
cleanup, restart, and lifetime replacement. Authority evidence includes fresh
and resumed fact feeds, submission settlement, exact retry, parked-result
replay, fold reads, restart or hibernation, and lifetime refusal. Both owners
prove stale, equal, and newer installation behavior; row-tombstone
non-resurrection; indexed query plans; clean reopen; integrity; and the
independent state witness.

The evidence classifier returns only `invalid`, `incomplete`, `provisional`, or
`ready-for-ADR-review`. It never returns a candidate ID, ranking, winner,
tie-break, or recommendation. `ready-for-ADR-review` means that the required
evidence is complete; it does not select the layout. Failed or duplicate cells,
unknown matrix coordinates, empty or non-indexed required query plans,
seed-discipline failures, missing raw metrics, or witness divergence make the
evidence `invalid`. Missing expected cells make it `incomplete`.

The initial absolute acceptance gates are provisional until maintained evidence
either ratifies or revises them before this ADR becomes Accepted:

| Operation                           | Physical mobile floor | Conditional normal profile              |
| ----------------------------------- | --------------------- | --------------------------------------- |
| Initial scalar installation         | at most 5 minutes     | browser 15 minutes; Bun 5 minutes       |
| Clean open plus one point read       | at most 3 seconds     | at most 2 seconds                       |
| Point read p95                      | at most 50 ms         | at most 25 ms                           |
| Durable scalar write p95            | at most 250 ms        | at most 100 ms                          |
| 512-fact prefix p95                 | at most 500 ms        | at most 250 ms                          |
| Approximately 1,000-row traversal p95 | at most 750 ms      | at most 300 ms                          |
| Restart recovery                    | at most 5 seconds     | at most 3 seconds                       |
| Browser page-owner heartbeat        | at most 100 ms        | at most 100 ms                          |

The 512-fact prefix is a private evidence workload, not a V1 response-count
constant. The maximum-byte V1 response remains a separate admission and atomic
installation proof under ADR-0163.

Cloudflare authority evidence also retains invocation wall time, CPU time, SQL
row counts, and platform-limit refusals. Public-network latency is not a SQLite
layout metric.

For the complete scalar store under the fixed scalar-only fixture, let `L` be
present scalar logical-state bytes and `N` be final-present scalar addresses.
The physical ceilings are:

```txt
steady allocated SQLite bytes
  <= 1.75 * L + 128 * N + 16 MiB

peak storage-root bytes
  <= steady allocated SQLite bytes
   + L
   + max(16 MiB, L / 8)

freelist_count / page_count <= 0.10
```

Peak storage-root bytes include the database, WAL, shared-memory, temporary
SQLite files, and the OPFS root high-water mark. These scalar-only ceilings
exclude row-document state and blob bytes, which keep their separate bounds and
storage policies.

Evidence that varies coordinate storage enumerates every address-bearing
relation it covers. A benchmark limited to current confirmed facts may compare
fact-table layouts, but it cannot decide whether coordinates are inline or
normalized across pending intents, sealed submissions, parked diagnostics,
document-liveness joins, or publication records. Schema-wide coordinate
ownership remains unresolved until the candidate boundary includes every
affected relation, workload, and constraint proof.

## Considered alternatives

- **Named databases inside one store.** Rejected because inventory, lifecycle,
  routes, captures, and identity remain database-scoped despite every replica
  synchronizing all of them.
- **Separate Device and Account stores.** Rejected because sign-in then needs an
  adoption or merge product with two simultaneous owners.
- **One physical file literally shared by every app and browser origin.**
  Rejected because sandbox and origin isolation make that impossible; adapters
  may replicate the same logical Epicenter without changing its public model.
