---
name: yjs
description: Apply Epicenter’s Yjs 14 patterns for the database document, transactions, persistence, and synchronization. Use when working with `@y/y`, CRDTs, collaborative editing, awareness, or Yjs storage and providers.
metadata:
  author: epicenter
  version: '1.0'
---

# Yjs 14 CRDT Patterns

The Yjs store and its sync were removed in `9f75a9bd51` (`packages/data` is
gone, and no package depends on `@y/y`); apps keep their data as files in a
folder through `@epicenter/folder`. The `packages/data` paths below name where
the store lived; read them from Git history, and treat this skill as the
design record for any Yjs work that returns.

## Reference Repositories

- [Yjs](https://github.com/yjs/yjs): CRDT framework for shared editing and offline-first data
- [Yjs Protocols](https://github.com/yjs/y-protocols): algorithmic grounding for sync and awareness

## Upstream Grounding

When conflict semantics, transaction origins, shared-type behavior, update encoding, storage growth, or shared-type APIs affect correctness, use source-backed grounding before relying on memory. If DeepWiki MCP is available, ask a narrow question against `yjs/yjs`; for sync and awareness algorithms, ask against `yjs/y-protocols`. If DeepWiki is unavailable or the repo is not indexed, use upstream source or official docs directly. Treat DeepWiki as orientation, then verify decisive details against the locally pinned `@y/y` types and source before changing code.

Epicenter targets `@y/y` 14 only. Do not add `yjs` 13, `y-indexeddb`, a compatibility reader, a package alias, a dual wire, or a fallback. Existing Yjs 13 code is replacement material, not a compatibility surface.

Skip DeepWiki for stable basics and repo-local patterns already documented below.

Read [references/document-design.md](references/document-design.md) before
choosing how new rows or fields are structured. Counters, user-controlled
ordering, and nested shapes each have a conflict behavior that is expensive to
change once data exists.

Read [references/debugging.md](references/debugging.md) when a document
converges to unexpected state or grows faster than its content.

> **Related Skills**: See `svelte` for reading store data into a component, and `typebox` for the schemas behind the `field.*` declaration helpers.

## Transactions, Origins, And Undo

- Yjs updates are commutative and idempotent. A state vector describes what a
  replica HAS; it does not order what it owes. A delete moves no client clock,
  so two replicas can hold the same vector and differ, which is why obligation
  in this store is a log position rather than a vector (ADR-0298). The cursor
  and the outbox both derive from one column on the update rows,
  `MAX(authoritySeq)` and `authoritySeq IS NULL`, so neither can disagree with
  the bytes it accounts for (`packages/data/src/store/log.ts`).
- Use `Y.encodeStateVector(doc)` to describe local clocks, then `Y.encodeStateAsUpdateV2(doc, remoteStateVector)` to send only missing updates.
- Persist and transmit bytes from the `updateV2` event. Replay them with `Y.applyUpdateV2(doc, update, origin)`.
- Wrap multi-write user actions in `doc.transact(() => { ... }, origin)`. This reduces observer churn and gives persistence, providers, and undo logic a useful origin.
- Treat transaction origins as the boundary for filtering provider echoes, app-authored operations, and undo tracking.
- Scope `Y.UndoManager` to concrete shared types. Set `trackedOrigins`, tune `captureTimeout`, and call `stopCapturing()` between logically separate commands.
- Use relative positions for collaborative cursor and selection anchors. Raw numeric indexes drift under remote edits.
- `Y.snapshot()` is a historical marker that depends on retained delete history. `Y.encodeStateAsUpdateV2(doc)` is the self-contained checkpoint format.
- Prefer separate top-level docs over Yjs subdocuments unless Epicenter owns the whole provider lifecycle for the subdoc path.

## Store Connection

- Yjs is network-agnostic. It supplies CRDT state, state vectors, updates, and awareness behavior, not Epicenter's connection topology, authorization, or durability contract.
- One socket per application, not one per open document. A replica connects to `STORE_SYNC_ROUTE.pattern` (`/api/store/v1/sync`, in `packages/sync/src/store-route.ts`) with a `namespace` naming the workspace and a `cursor` naming its own durably applied position, so a reconnect is a catch-up rather than a fresh start (ADR-0222).
- Whose data it is never appears in the query. It comes from the resolved bearer, server-side, so there is no value a client can put in the URL that reaches another partition (ADR-0092).
- Browser upgrades authenticate through exactly one `bearer.<token>` subprotocol entry, because a browser upgrade cannot set `Authorization`; the mount echoes only the main subprotocol on the 101, so the token never round-trips. Non-browser clients may use an `Authorization` header. Do not use cookie-only upgrades, query-string credentials, or post-accept authentication frames.
- The wire is framing and nothing else: `push`, `ack`, `refuse`, `entry`, `offer`, `snapshot`, `wanted` (`packages/data/src/sync/frames.ts`). No frame knows what an update means, what a row is, or what Yjs is, which is exactly why chunking is safe at that layer.
- Large updates are chunked at `CHUNK_BYTES`, set by Cloudflare's documented Durable Object SQLite value cap rather than by anything about Yjs. Do not raise it to the measured wall; the documented limit is the one Cloudflare is entitled to enforce.
- Presence is deliberately absent until a concrete consumer earns awareness state and disconnect cleanup. If added later, awareness is ephemeral and must never be persisted into the Y.Doc or the SQLite update log as canonical data.

## One Document Per Database

A database is one `Y.Doc` (ADR-0295): roots are `tables:<name>` and `kv`, a row
is a nested `Y.Type` attribute on its table root, and a field is an attribute
on the row. Holding the attribute is what it means to exist, and removing it is
what deletion does. A row's rich content is a nested type on the row as well
(ADR-0296); there is no second document, address, or document manager. The
nesting is not stylistic: `Item.write` calls `findRootTypeKey`, a linear scan
of `doc.share`, so one root per row makes encoding quadratic in rows (5,417 ms
for 20,000 rows against 13 ms nested).

Only `Doc.get` mints a root, and every key reaching it must be a table name the
database declares (`packages/data/src/store/document.ts`). Reading an unknown
row through `getAttr` costs nothing, while a misspelled table name costs a
permanent root.

## Two Signals, And Which One Fires

- `table.subscribe` fires when a table's SHAPE changes: a row added, removed,
  or its value fields edited. It does NOT fire for an edit inside a row's
  rich content, so a list does not wake at typing frequency.
- `table.watch(rowId, field, listener)` fires for edits inside one rich field
  of one row, local or remote. It is the only way to hear text typed into a row.

The split follows the library. Delivery routes off `transaction.changed`, which
Yjs fills with the types a transaction modified directly, so a keystroke in a
rich field names that field's type, not the table root. `kv.subscribe` follows
the table's shape: a ping meaning "re-read".

## Owner-Side Persistence

One document, so one chain: `_updates (id, bytes, authoritySeq)` in SQLite, and
the matching record in the browser's IndexedDB. There is no per-document
partition and no separate outbox table: what a replica still owes is the rows
with `authoritySeq IS NULL`, served by a partial index (ADR-0238, ADR-0298). Do
not add a separate IndexedDB provider or a second document store.

- Hydrate BEFORE attaching the `updateV2` listener. Replaying stored bytes
  through the listener would re-append them; the store applies its history
  first and then attaches, and throws if foreign bytes ever reach the listener
  as local work (`packages/data/src/store/store.ts`).
- A locally authored append joins the durable queue as owed work.
  Authority-accepted bytes arrive through the remote-apply path and create no
  outbound obligation.
- The chain folds at `SNAPSHOT_FOLD_THRESHOLD`. A syncing store folds only the
  acknowledged prefix, replaying it into a fresh `gc: true` document and
  rewriting it as one complete V2 state update; owed appends stay where they
  are, because the sender offers them individually and an acknowledgement
  names them by id. A store that does not sync folds everything.
- Treat replay corruption as storage failure: a document that cannot hydrate refuses its open rather than handing out a half-hydrated handle.

## Storage Optimization

Yjs 14 has one shared type, `Y.Type`, which is map, list, and rich text at
once; there is no `Y.Map`, `Y.Text`, `Y.Array`, or `Y.XmlFragment` class (see
ADR-0296 and the installed `@y/y` declarations). Code or advice naming them is
Yjs 13 and is replacement material. Attribute tombstones retain the key
forever, and every `setAttr(key, value)` creates a new internal item and
tombstones the previous one, which is why
`gc: true` is what collapses a field edited 5,000 times down to two structs.

## Raw Types At The Boundary

A `Y.Type` handed out for a row's rich field is a live CRDT reference and is
meant to be bound to an editor. The store hands the editor the real type rather
than a proxy, because a copy would break the merge that makes it worth having.

A raw type can reach its parent and document; it is not a security sandbox.
Consumer code may bind to it, but it should not construct, cast, or repair the
row layout, or branch on content modes the owning module should handle. The
store owns that layout in `packages/data/src/store/document.ts`. When consumer
code needs an operation on raw types, such as an append or a format
conversion, give that operation to the owning module or a format bridge beside
it. Ask: "Could this consumer do its job with only the typed API?"

See the article `docs/articles/yjs-abstraction-leaks-cost-more-than-the-abstraction.md` for the full pattern with real examples.

## References

- [Learn Yjs](https://learn.yjs.dev/) - Interactive tutorials
- [Yjs Documentation](https://docs.yjs.dev/) - API reference
- [Yjs INTERNALS.md](https://github.com/yjs/yjs/blob/main/INTERNALS.md) - How Yjs works internally
- [GitHub issue #520](https://github.com/yjs/yjs/issues/520) - Conflict resolution discussion with dmonad
- [fractional-indexing](https://github.com/rocicorp/fractional-indexing) - Production library
- [YATA paper](https://www.researchgate.net/publication/310212186_Near_Real-Time_Peer-to-Peer_Shared_Editing_on_Extensible_Data_Types) - Academic foundation
- `packages/data/src/store/document.ts`: the application-document grammar (roots, row types, field reads)
- `packages/data/src/store/log.ts` and `packages/data/src/store/persistence.ts`: the durable update log, the derived outbox and cursor, and the persistence queue
- `packages/data/src/sync/`: the Yjs 14 wire (frames, connection, client, authority)
- [ADR-0295](../../../docs/adr/0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md): one document per database, and a row holds its rich content (supersedes ADR-0248)
- [ADR-0298](../../../docs/adr/0298-the-authority-is-byte-blind-and-a-cursor-is-a-log-position.md): a cursor is a log position
- [ADR-0221](../../../docs/adr/0221-a-table-names-the-rows-a-commit-touched-and-says-so-after-the-projection-commits.md): what `subscribe` reports and when it fires
- [ADR-0146](../../../docs/adr/0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md): Yjs 14-only persistence decision
- [ADR-0159](../../../docs/adr/0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md): one owner-side SQLite update log and shared attachment seam
