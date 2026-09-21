# 0417. A data address holds one document

- **Status:** Proposed
- **Date:** 2026-09-21
- **Amends:** [ADR-0276](0276-an-authority-holds-a-numbered-succession-of-generations-and-nothing-is-ever-overwritten.md), [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md), [ADR-0285](0285-a-generation-is-a-url-parameter-and-a-device-stores-no-selection.md), [ADR-0292](0292-a-database-opens-an-exact-generation-cache-first-and-bootstraps-account-misses.md), [ADR-0324](0324-a-database-address-is-its-data-id-and-generation-and-the-definition-declares-its-authority.md), [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md), [ADR-0340](0340-an-opened-store-knows-its-own-address-and-its-own-connection.md), and [ADR-0412](0412-app-data-addresses-name-scopes-not-libraries.md) at generation identity, selection, and replacement for current data, including checkout manifests and retirement propagation.
- **Unbuilt:** Removal of active generation machinery, consolidation of authority and IndexedDB backing, generation-free checkout manifests, and refusal of a sync cursor beyond the authority head.
- **Relates:** [ADR-0385](0385-initial-generation-selection-is-a-server-commit.md) preserves canonical initialization; [ADR-0407](0407-app-owns-the-declaration-and-data-engine.md) preserves historical bytes and the refusal to hide them behind new data.

## Context

Generations supported choosing a historical database and replacing a live
document while other devices retained its old state. The current product opens
one document at a stable address. Recovery applies readable files through
ordinary working-copy edits. The production API has no activation or restore
caller; replacement exists in tests and evidence fixtures.

Keeping replacement requires an activation transaction, retry receipts,
generation-bound log operations, socket admission, cache invalidation, and
retirement propagated through persistence, the App, and page recovery. That
machinery protects a capability we no longer require. It does not protect an
arbitrary server wipe: deleting the generation metadata permits initialization
to reuse generation 1.

The [caller audit and design review](../reports/20260921-generation-removal.md)
identify the removable owners and the guarantees independent of replacement.

## Decision

**A data address holds one document. Synchronization preserves its Yjs
lineage; replacing that lineage is outside synchronization’s guarantees.**

There is no generation number, replacement identifier, history selector, or
remote activation operation. An address distinguishes its application, data
domain, scope, and owner. Personal data derives its remote owner from the
authenticated principal. Local replicas retain their authority and actor
partitioning. Removing generations never merges two owners' data.

Current Durable Object names, IndexedDB names, and HTTP routes retain their
bytes, including `/current` and the device store's fixed `/1` suffix. Those
names already identify stable storage. No code interprets the suffix as a
generation, increments it, or discovers siblings. Changing source types and
protocol fields requires no storage-address migration. A later store-first
layout is a separate transition, not part of generation removal. It must
preserve document lineage and pending work rather than recreate rows from an
export.

**Initialization and synchronization need one authority implementation.**

The authority owns an opaque snapshot and update log. Initialization commits a
complete baseline once and returns the canonical snapshot plus every update
through the captured head. A snapshot establishes initialization; no separate
generation row or replacement receipt participates. The production server
adapter refuses a sync upgrade until a baseline snapshot exists. This protects
canonical initialization from an append into an uninitialized log. The generic
log and hub remain usable by sync-lab without a second authority flavour.

One hub belongs to the server object. It has no replaceable lifetime or
generation-bound wrapper. Authentication and successful membership precede
accepted pushes. Hub join refuses a cursor beyond the log head: a cursor must
name a position the log has reached. Refusal closes the socket without deleting
local data or adding a client recovery state. Existing backoff applies. This
check cannot identify an old replica whose cursor fits inside a replacement log.

The socket carries the data address and cursor. Its durable attachment keeps
the cursor and authorization deadline. Generation admission and retirement
frames disappear; the client attaches when the socket opens. A connection
deadline still covers a socket that never opens. Reconnect, acknowledgement,
chunking, and snapshot-coverage checks remain.

**Device and personal data use one IndexedDB backing implementation.**

A complete baseline and its position are installed atomically before a store
becomes usable. Subsequent writes preserve a nonempty durable update chain.
That chain establishes cache readiness. Personal cache misses download and
validate the canonical state; device data initializes locally. Network failure
never establishes that remote data is empty.

The generation header, separate current-cache implementation, destructive
persistence discard path, and document-retirement signal disappear. The App
still owns cancellation, resource closure, and admission release. Closing a
store still fences retained handles; failed cleanup cannot release ownership
prematurely. A transport failure cannot erase the local document or its outbox.

**An opened store keeps its document and backing until its owner closes it.**

The owner controls the connection lifetime, including cleanup during failed
opening. Transport delivers updates, acknowledges submissions, refuses traffic,
and disconnects. It cannot replace the document, erase durable storage, or
retire the App. Remove the store's unused `stopSync` surface and separate
`syncStopped` flag with retirement choreography. Reconnect still belongs to the
connection; it does not create a new store lifetime.

Remove the leftover addressed `ReplicaDocument` and `ReplicaData` types. Their
only executable consumer is the Worker probe, which can describe its own
fixture. Checkout retains its structural destination contract.

**Working-copy identity names the destination, without a generation.**

Manifests retain owner and destination checks, row values, body hashes, and the
comparison baseline used by Pull and Push, as defined by [ADR-0418](0418-push-translates-file-differences-into-ordinary-edits.md). New manifests omit `generation`.
An existing unused generation field is ignored, without a version branch or
new lineage token. Ordinary content recovery edits the current working copy
and submits permitted field differences; it does not reset any replica.
Working-copy Push refuses collaborative body edits. Full body restoration,
creation, and deletion are not implied by the narrowed agent workflow.

## Outside the contract

No supported operation replaces a document's lineage. Whoever replaces it out
of band must discard every old replica's live document, durable updates,
outbox, and cursor before that replica reconnects. An offline device can be
cleared later, before its next connection. Working copies must discard their
old manifests and establish fresh Pull baselines before their next Push.
These are the operator's responsibilities, not globally asserted invariants.

There is no device registry, proof that clearing finished, automatic
invalidation, or repair of an incomplete replacement. A forgotten replica can
skip new entries, submit old changes, or offer an old snapshot even with an
empty outbox. Clean self-recovery is not promised.

Unsynchronized work is lost unless preserved separately. Readable Markdown
files and root `kv.json` can preserve logical values and rendered content. The
field-only agent Push path is not a full restore mechanism: it refuses body
edits, and row creation is not yet in its settled scope. Application and CLI
recovery surfaces are unbuilt. These files do not preserve exact Yjs history or
independently stored blobs. Applying old Yjs bytes to a live document merges them; it does not roll
the document back. Binary whole-document restore is outside this contract.

Clearing one personal cache makes it download the remote document again.
Clearing document storage does not erase named SQL files, blobs, credentials,
or exports. Whole-account erasure remains a separate task.

## Consequences

Remove activation and receipts, generation checks and wire fields, historical
selection helpers with no callers, the current-cache wrapper, and the
retirement-only tests and fixtures. Do not preserve them with a constant 1,
an opaque identifier, or an unused replacement hook.

Keep log positions, client cursors, outbox IDs, acknowledgements, snapshot
folding, canonical bootstrap, and ordinary App shutdown. These solve current
editing and delivery problems. Existing unused generation metadata may remain
on disk; the runtime neither reads nor writes it and introduces no cleanup job.

Historical numbered storage remains untouched. The ledger-backed HTTP 409
refusal from ADR-0407 stays until historical-data ownership and disposition
are resolved separately. It is not a generation selection or migration path.
Clients and servers update together; no parallel legacy protocol is retained.

No device registry, reset coordinator, restore endpoint, or automated global
reset UI is introduced. No manifest token, initialization marker, emptiness
probe, or retry policy encodes replacement state. A future requirement to replace data while unknown
replicas remain writable must reopen this product decision.

## Considered alternatives

- Keep generations for a future restore product: every ordinary connection
  pays for replacement that has no production caller.
- Replace numbers with UUIDs or reset tokens: preserves the same identity,
  comparison, invalidation, and recovery machinery.
- Keep one constant generation: removes its protection while retaining its
  types, checks, headers, and lifecycle branches.
- Enumerate devices and coordinate their reset automatically: adds a replica
  registry and a distributed maintenance protocol.
- Use a bodyless bootstrap with no initialized baseline: changes the empty-log
  protocol to avoid a small existing transaction with a useful completeness
  guarantee.
- Rename durable addresses or migrate unused metadata away: adds storage
  transition work without changing the one-document contract.
- Retain the old working-copy baseline across replacement: compares readable
  files against history the destination no longer holds.
