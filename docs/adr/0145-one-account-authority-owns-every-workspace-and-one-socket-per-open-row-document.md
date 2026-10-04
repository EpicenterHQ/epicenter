# 0145. One account authority owns every workspace and one socket per open row document

- **Status:** Superseded
- **Date:** 2026-07-18
- **Superseded by:** [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md) for the ownership model and [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md) for document synchronization and persistence
- **Amended by:** [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md) (workspaces leave the principal authority), [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md) (supersedes this ADR's document-plane exact-byte retention, no-cache, compaction, and presence mechanics; the authority is instead the trusted Yjs joiner and compactor over a bounded live chain)
- **Amends:** server document ownership from
  [ADR-0133](0133-row-authority-stores-documents-as-sequence-addressed-update-logs.md);
  the generic room-address consequences of
  [ADR-0092](0092-identity-is-the-partition.md), whose
  principal-is-the-partition rule this decision preserves and extends to actor
  identity; the issuance vocabulary and the "row synchronization never consults
  storage state" sentence of
  [ADR-0137](0137-hosted-storage-is-one-eventually-enforced-physical-account-allowance.md);
  and the enrollment and permanent-retired-identity rules of
  [ADR-0141](0141-authority-current-state-and-receipt-watermarks-drive-row-convergence.md).
  Bearer transport from
  [ADR-0095](0095-websocket-room-auth-uses-route-owned-subprotocol-bearers.md)
  remains.

## Context

Scalar rows and row documents have different synchronization laws but one
lifecycle owner: the row owns its document, and deletion must be one
transaction. The previous proposal gave every workspace its own Durable Object
and added a deployment-owned catalog that minted opaque authority keys so a
future shared workspace could map several principals to one actor. Accepted
ADR-0092 already deleted that second ownership axis: the authenticated
principal is the partition by definition, and future sharing is a resolver
decision (many accounts to one shared principal), not a second mapping.

Cloudflare facts ground the actor choice. `idFromName` is pure computation and
creates nothing; an object activates on its first request, and idle
hibernation-eligible objects bill no duration. A SQLite-backed object stores up
to 10 GB, reports its exact size through `sql.databaseSize`, deletes everything
atomically through `deleteAll()`, and owns hibernating WebSockets
(`getWebSockets()` enumerates them without tags). Durable Object namespaces
cannot be enumerated, and an empty database costs roughly 12 KB. Plan
allowances in the billing catalog are blob-dominated (free 100 MB, paid tiers
5 to 50 GB with R2 outside the authority), so structured account data fits one
object with an explicit ceiling.

## Decision

One account authority actor per principal owns all durable server state for
every workspace that principal has: `idFromName(principalId)`, one SQLite
database. Named workspaces are logical namespaces inside it; workspace-scoped
rows, change markers, deletion markers, replica receipts, document snapshots,
and document update logs carry a `workspace_id` column instead of living in
separate objects. The self-hosted instance composes the same shape: one
instance principal, one authority database, many named workspaces.

Two route families expose the data protocols; there is no creation route:

```txt
workspace row HTTP      /api/workspaces/:workspaceId/records/...
                        scalar push, pull, and acquisition
row document WebSocket  /api/workspaces/:workspaceId/tables/:table/rows/:rowId/document
                        Yjs 14 frames for one fixed row address
```

Package ownership is unchanged: `@epicenter/row-sync` owns the portable scalar
wire contract, admission rules, deterministic folding, and receipt digests
without opening an authority database; the AGPL server workspace authority owns
the complete SQLite schema and every durable transaction.

### Identity, reads, and first writes

Security has three facts and one surface. The deployment authenticates an
upgrade-time or request-time credential into a principal. The authority address
derives deterministically from that principal alone, so no request can address
another principal's state and no catalog, grant, authority key, or per-request
authorization lookup exists. Row liveness is checked inside the selected
authority. Browser sync credentials arrive through exactly one `bearer.<token>`
subprotocol entry (ADR-0095); cookie-only upgrades, query-string tokens, and
post-accept authentication frames remain forbidden.

Reads create no logical workspace, no replica receipt, and no user-data state.
A first read may activate and initialize the single account database (a
one-time, roughly 12 KB physical artifact of any active account), and pull
cursors remain client-held, so a brand-new device can read and acquire a full
baseline with zero prior server round trips beyond authentication.

There is no enrollment wire operation and no workspace-creation operation. The
first accepted push that binds a new `(workspace, replica)` pair creates the
workspace row, registers the replica receipt, and folds round one in one
allowance-checked transaction. A lost response returns the stored receipt on
retry exactly as ADR-0141 specifies; a restored or forked replica is detected
by the same receipt and digest rules on its first push instead of at a separate
enrollment step. A refused first push leaves zero durable state.

### Allowance and the physical wall

Account allowance is checked at exactly two moments: when a first push would
bind a new `(workspace, replica)` pair, and when a blob upload grant is issued
(ADR-0089 path, unchanged). Once a pair exists, its synchronization is
economically unconditional forever: rounds, document updates, and deletions
from known replicas are never refused for allowance. Enforcement is eventual
and observational; the account's structured usage is one `sql.databaseSize`
reading, and billing consequences happen outside synchronization.

Separately, one physical emergency wall protects the platform object limit: at
a fixed headroom below 10 GB (a build-pinned constant with margin larger than
the largest admissible round, frame, or compaction rewrite), the authority
refuses whole scalar rounds with the retryable storage-limit verdict and
refuses document appends by closing retryably, without inspecting or
classifying contents. Reads, downstream document sync, export, and workspace
and account deletion remain available at the wall. The wall is an explicit
emergency exception to "record deletion is always available": a row-deletion
round may park behind a refused round there, and the guaranteed escapes are
workspace deletion and account deletion, which are route-level transactions
that shrink the database and are never refused. Parked work resumes through
ordinary retry once space frees. `databaseSize` telemetry ships with the first
production wave so accounts are observed long before the wall.

### Deletion without a permanent tombstone table

Row ids are globally unique and never reused by conforming runtimes. Only
`create` establishes a row; scalar updates and document writes against an
absent address cannot create it. Deleting a row removes the live row, writes a
bounded deletion marker into the change feed, and cascades the server document
snapshot and update log through foreign keys in one transaction. Replicas
observe the marker, remove the row, and revoke the open document through the
same local revocation path local deletion uses. Markers compact at the
retention floor; a replica behind the floor performs complete acquisition,
which removes confirmed local rows absent from authority state while preserving
legitimate pending local intents. Permanent per-replica receipts prevent an
accepted pre-deletion create from folding again.

No permanent tombstone table exists. After a deletion marker compacts, a
non-conforming client of the same account can re-mint a deleted id; this is
accepted as self-harm confined to that account's own data, it loses no data,
and export and recovery remain intact. Receipts stay permanent; transport
compaction bounds payload and marker history, never replica identity.

### The document plane

Each client opens one dedicated WebSocket per row document it currently has
open. This is not multiplexing: the socket's route binds one immutable address,
frames carry no addresses or subscriptions, and every socket for the account
terminates at the same authority actor, which stores each socket's fixed
structured address and negotiated subprotocol in its hibernation attachment
(within the 16,384-byte cap) and verifies the subprotocol before decoding any
frame. An actor restart closes every restored document socket with an ordinary
retryable close, so the reconnect state-vector exchange owns repair, including
a crash between commit and broadcast; hibernation absorbs idle transport
acceptance, never document-session continuity. Fanout enumerates the actor's
sockets and compares the complete attachment address; no hashed tag or
secondary index ships until measured socket counts earn one.

The authority retains no live `Y.Doc`. Admission calls one atomic store
operation that rechecks row liveness and loads committed state in a single
snapshot; a live row hydrates a disposable document to compute the symmetric
state-vector exchange, then discards it. Update acceptance rechecks liveness
inside its transaction, validates the candidate against disposably hydrated
committed state, appends the exact bytes, commits, and broadcasts those bytes
to the address's other sockets. There is no cache to advance, rebuild, or race
against deletion; a crash after commit and before broadcast is repaired by the
next state-vector exchange.

The authority enforces one compound document bound exactly, inside the append
transaction, on the canonical post-candidate state it already computes: an
encoded byte ceiling and a decoded struct ceiling (ADR-0146 owns the bound's
definition and constants). A refused candidate mutates nothing. There is no
terminal document verdict on the wire: WebSocket close 1009 remains only as a
defensive transport backstop against a client whose estimate was stale, it
carries no reason taxonomy, and it causes no product-state transition. Clients
estimate the same bound with exact measures, suppress every upstream
update-bearing frame while over it (including the deferred handshake reply,
which always waits until downstream state is applied and measured), keep
receiving downstream, and resume on their own when a measure comes back under.
Local editing, persistence, and logical export remain available throughout.
Every other refusal, including a not-live row and the physical wall, is an
ordinary retryable close: the client's scalar plane already knows whether its
row is awaiting admission, and scalar synchronization installing a deletion is
what stops the retry loop. No `pending-row` or `row-deleted` code and no
transient accept-then-close admission exist.

Multiplexing remains deferred, not a parallel mode. Before this ADR becomes
Accepted, the production endpoint must pass the iPhone Safari and installed-PWA
smoke with Private Relay at one, two, four, and eight simultaneous
authenticated same-origin document sockets, including background and foreground
transitions. Failure selects one workspace socket as the sole topology.

## Consequences

- The workspace catalog, grants, opaque authority keys, per-request
  authorization lookups, lifecycle index, explicit creation route, enrollment
  operation, per-workspace Durable Objects, permanent tombstone table,
  transient document admission, reserved `pending-row` and `row-deleted`
  codes, authority live-document cache, and socket-tag machinery are all
  deleted rather than deferred.
- Whole-account enumeration, storage observation, and deletion collapse to SQL
  over one database, one `databaseSize` reading, and one `deleteAll()`.
  Workspace deletion is a pure SQL transaction.
- Structured account data has an explicit ceiling below 10 GB; blobs scale
  separately in R2. `databaseSize` telemetry is the tripwire for revisiting
  the actor boundary; per-workspace sharding would return only as a measured
  decision and would bring an enumeration index back with it.
- One actor serializes each account's traffic and forms one failure domain.
  At human cadence (a heavy account writes tens of rounds per second at most,
  with few open documents) this is speculative cost; the Safari gate and
  telemetry guard the assumption.
- A hostile account can grow structured data to the wall at bounded cost
  (roughly $2 per month of storage and $10 of one-time row writes at current
  Cloudflare prices), detectable by observation.
- Known replicas always drain, so an over-allowance account's existing devices
  keep synchronizing while its new devices and new workspaces park at first
  push with the existing pending storage-limit state.

## Considered alternatives

- **A deployment-owned catalog minting opaque canonical authority keys with
  per-principal grants.** Rejected: it rebuilds the second ownership axis
  ADR-0092 deleted, puts a lookup in front of every request, and serves
  multi-principal sharing that no current promise or caller requires;
  ADR-0092's shared-principal seam already prevents split history. Its one
  earned kernel, enumeration, is owned by the account database itself.
- **One Durable Object per workspace plus a lifecycle index.** Rejected:
  enumeration, account storage observation, and account deletion all require
  a second deployment-owned store, and the isolation it buys is speculative at
  human cadence.
- **One Durable Object per document.** Rejected: the row owns the document's
  lifetime, and separate actors replace one deletion transaction with
  revocation RPCs, permanent revoked states, capabilities, or garbage
  collection; per-document objects are also unenumerable and pay the empty
  database floor per document.
- **A wire-visible enrollment operation.** Rejected: its four responsibilities
  (allocation, policy, identity registration, lineage verification) all live
  inside first-push admission with identical guarantees and one fewer
  operation, parser, and client state pair.
- **A permanent tombstone table.** Rejected: with unique ids, create-only
  establishment, bounded markers, acquisition, and permanent receipts, its
  only remaining job was defending an account against its own non-conforming
  client, which does not earn a permanent negative record for every user.
- **Typed `pending-row` and `row-deleted` closes with transient admission.**
  Rejected: the client's own scalar plane already owns both facts; a refused
  upgrade and a typed transient close produce identical retry behavior, and
  the scalar plane's revocation is what actually closes the loop.
- **Economic checks on every byte-growing admission.** Rejected: refusing
  ordered rounds deadlocks deletion behind parked work or demands resealing
  machinery; ADR-0137 already ruled that synchronization never consults the
  allowance.
- **A live authority document cache.** Rejected: acceptance already hydrates
  disposable committed state per update, so the cache was a second
  materialization whose only consumer was rare connect-time diffs, at the cost
  of advance, mismatch, rebuild, and deletion-race machinery.
- **One multiplexed workspace WebSocket.** Rejected for now: it adds mutable
  subscription recovery, address framing, and address-scoped fanout before
  measured socket pressure earns them; it returns only as the sole topology if
  the Safari gate fails.
