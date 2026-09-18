---
name: yjs
description: Apply Epicenter’s Yjs 14 patterns for row documents, transactions, persistence, and synchronization. Use when working with `@y/y`, CRDTs, collaborative editing, awareness, or Yjs storage and providers.
metadata:
  author: epicenter
  version: '1.0'
---

# Yjs 14 CRDT Patterns
## Reference Repositories

- [Yjs](https://github.com/yjs/yjs): CRDT framework for shared editing and offline-first data
- [Yjs Protocols](https://github.com/yjs/y-protocols): algorithmic grounding for sync and awareness

## Upstream Grounding

When conflict semantics, transaction origins, shared-type behavior, update encoding, storage growth, or shared-type APIs affect correctness, use source-backed grounding before relying on memory. If DeepWiki MCP is available, ask a narrow question against `yjs/yjs`; for sync and awareness algorithms, ask against `yjs/y-protocols`. If DeepWiki is unavailable or the repo is not indexed, use upstream source or official docs directly. Treat DeepWiki as orientation, then verify decisive details against the locally pinned `@y/y` types and source before changing code.

Epicenter targets `@y/y` 14 only. Do not add `yjs` 13, `y-indexeddb`, a compatibility reader, a package alias, a dual wire, or a fallback. Existing Yjs 13 code is replacement material, not a compatibility surface.

Skip DeepWiki for stable basics and repo-local patterns already documented below.

Read [references/document-design.md](references/document-design.md) before
choosing how a new row document is structured. Counters, user-controlled
ordering, and nested shapes each have a conflict behavior that is expensive to
change once data exists.

Read [references/debugging.md](references/debugging.md) when a document
converges to unexpected state or grows faster than its content.

> **Related Skills**: See `svelte` for reading store data into a component, and `arktype` for the expression strings a workspace is written in.

## Transactions, Origins, And Undo

- Yjs updates are commutative and idempotent. A state vector describes what a
  replica HAS; it does not order what it owes. A delete moves no client clock,
  so two replicas can hold the same vector and differ, which is why obligation
  in this store is a log position rather than a vector. Both the cursor and the
  outbox are then DERIVED from one column on the update rows, `MAX(authoritySeq)`
  and `authoritySeq IS NULL`, so neither can disagree with the bytes it accounts
  for (`packages/app/evidence/data/invariants.test.ts`, ADR-0298).
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
- The wire is framing and nothing else: `push`, `ack`, `refuse`, `entry`, `offer`, `snapshot`, `wanted` (`packages/app/src/data/sync/frames.ts`). No frame knows what an update means, what a row is, or what Yjs is, which is exactly why chunking is safe at that layer.
- Large updates are chunked at `CHUNK_BYTES`, set by Cloudflare's documented Durable Object SQLite value cap rather than by anything about Yjs. Do not raise it to the measured wall; the documented limit is the one Cloudflare is entitled to enforce.
- Presence is deliberately absent until a concrete consumer earns awareness state and disconnect cleanup. If added later, awareness is ephemeral and must never be persisted into the Y.Doc or the SQLite update log as canonical data.

## One Document Per Application

An application is ONE `Y.Doc`. Roots are `tables:<name>` and `kv`. A row is a
nested `Y.Type` attribute on its table root, a field holding a **value** is a
JSON attribute on the row, and the one field holding a **node** is a nested
`Y.Type` at the row's reserved `content` key (ADR-0295, ADR-0309). Holding the
attribute is what it means to exist; removing it is what deletion does, and it
reclaims the row's whole subtree in one operation.

Those two words are the vocabulary. A value is replaced whole on write, so two
devices writing one converge on a winner. A node is edited in place, so two
devices editing one both keep every keystroke.
<!-- vocab-check: ignore-next-line (naming what is retired) -->
Their retired names are `scalar` and `prose`; both belong in no new code or documentation (ADR-0309).

The nesting is not stylistic. `Item.write` calls `findRootTypeKey`, a linear
scan of `doc.share`, so one root per row makes encoding quadratic in rows
(5,417 ms for 20,000 rows against 13 ms nested).

There are no independent row documents. A row's content node used to live in its own
top-level document at a derived address, with a document manager, a tombstone
table and an `openDocument` verb (ADR-0248); ADR-0295 collapsed all of it into
the row. Advice naming `documents.ts`, `openDocument`, `_tombstones`, or
"hydrate the row's document" is describing a design that no longer exists.

```typescript
// Values are attributes on the row, written through the table.
db.tables.notes.update(noteId, { title, pinned: true });

// The content node is ON the row, read synchronously with everything else.
const note = db.tables.notes.get(noteId);
const body = note?.content;           // a live Y.Type an editor binds to
```

Inside the application document only `Doc.get` mints, and every key reaching it
must be a table name the database declares: reading an unknown ROW through
`getAttr` costs nothing, while a misspelled TABLE name costs a permanent root.

## Three Signals, And Which One Fires

- `table.subscribe` fires when a table's SHAPE changes: a row added, removed,
  or a value edited. It does NOT fire for an edit inside a content node. It
  hands the listener the ROW IDS the commit touched, so a consumer holding a
  projection rebuilds only what moved; a consumer that just re-reads may
  ignore them.
- `table.watch(node)` fires for edits inside one content node, keyed by the
  node's own identity.
- `kv.subscribe` fires when any declared key changes, and carries nothing.
  There are ten keys, so naming them would buy nothing.

The distinction is forced by the library. Delivery routes off
`transaction.changed`, which Yjs fills with the types a transaction modified
DIRECTLY, so a keystroke in a body puts the BODY's type there; its parent is
the row, not the table root. Nothing bubbles to the table. A surface that
watches a table for changes inside a node sees nothing.

## Owner-Side Persistence

One document, so one chain: `_updates (id, bytes, authoritySeq)` in SQLite, and
the matching object store in the browser's IndexedDB. There is no per-document
partition, no `_tombstones`, and no separate `_outbox` — what a replica still
owes is the rows with `authoritySeq IS NULL`, which is a partial index rather
than a second table (ADR-0238). Do not add a separate IndexedDB provider or a
second document store.

- Hydrate BEFORE attaching the `updateV2` listener. Replaying stored bytes
  through the listener would re-append them; the engine applies its history
  first and then attaches, and throws if a foreign apply ever reaches the
  listener, so a mistake here fails the open loudly rather than duplicating a
  log (`packages/app/src/data/store/store.ts`).
- A locally authored append joins the durable queue owed. Authority-accepted
  bytes arrive on a remote origin and create no outbound obligation, which is
  what the one listener checks before appending.
- The chain compacts by ROW, and the row's `authoritySeq` picks which of two
  mechanisms applies (ADR-0301). Rows the authority has taken replay into a
  fresh `gc: true` document and rewrite as one complete V2 state update: replay
  rather than `mergeUpdatesV2`, because merging does not GC and collapsing
  tombstones is the point. `encodeStateAsUpdateV2` folds buffered pending state
  back into its output, so a fold taken while dependencies are missing cannot
  silently drop them.
- Rows still OWED cannot take that path, and this is the one to get right. A
  whole-document re-encode is not a delta the authority could be offered, so
  owed rows collapse with `mergeUpdatesV2` into one resendable row that takes a
  NEW id above every existing one. Folding them like acknowledged rows would
  offer the authority a whole document per keystroke; inheriting a lower id
  would let an earlier acknowledgement stamp bytes it never carried.
- Treat replay corruption as storage failure: a document that cannot hydrate refuses its open rather than handing out a half-hydrated handle.

## Storage Optimization

v14 has ONE shared type, `Y.Type`, reached as `doc.get(name)` for a map-like
root or `doc.get(name, 'text')` for a text one. There is no `Y.Map`, `Y.Text`,
`Y.Array` or `Y.XmlFragment`; code or advice naming them is Yjs 13 and is
replacement material.

Attribute tombstones retain the key forever, and every `setAttr(key, value)`
creates a new internal item and tombstones the previous one, which is why
`gc: true` is what collapses a field edited 5,000 times down to two structs.

## Raw Types At The Boundary

A `Y.Type` handed out by a table handle is a live CRDT reference and is MEANT
to be bound to an editor. That is the design: the store hands the editor the
real thing rather than proxying it, because a copy would break the merge that
makes it worth having.

What does not belong in a feature:

- **Constructing the layout.** A feature does not decide which attribute a row
  keeps its content node under. It asks the table for the row and reads the declared
  field.
- **Casting into shape.** `as Y.Type` outside `packages/app/src/data/store/` means
  something is reading a document the store owns without going through it.
- **Reaching the document.** `doc.get(...)` in a feature bypasses the
  declaration, the conformance lens, and the durable queue at once.

The store's own boundary is `packages/app/src/data/store/document.ts`: it holds one
cast, at `rowType`, and states why (a container whose attributes are themselves
types has no expressible configuration, so a table root stays untyped while a
ROW's shape is declared). Everything downstream of that line is typed.

## References

- [Learn Yjs](https://learn.yjs.dev/) - Interactive tutorials
- [Yjs Documentation](https://docs.yjs.dev/) - API reference
- [Yjs INTERNALS.md](https://github.com/yjs/yjs/blob/main/INTERNALS.md) - How Yjs works internally
- [GitHub issue #520](https://github.com/yjs/yjs/issues/520) - Conflict resolution discussion with dmonad
- [fractional-indexing](https://github.com/rocicorp/fractional-indexing) - Production library
- [YATA paper](https://www.researchgate.net/publication/310212186_Near_Real-Time_Peer-to-Peer_Shared_Editing_on_Extensible_Data_Types) - Academic foundation
- `packages/app/src/data/store/document.ts`: the application-document grammar (roots, row types, field reads)
- `packages/app/src/data/store/log.ts` and `packages/app/src/data/store/persistence.ts`: the durable update log, the outbox, and the persistence queue
- `packages/app/evidence/data/invariants.test.ts`: the library behaviour this design rests on, pinned against the installed rc
- `packages/app/src/data/sync/`: the Yjs 14 wire (frames, connection, client, authority)
- [ADR-0295](../../../docs/adr/0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md): one document per application, and a row holds its rich content (supersedes ADR-0248)
- [ADR-0309](../../../docs/adr/0309-a-field-holds-a-value-or-a-node-and-the-retired-words-fail-the-build.md): a row is its id, its values, and one node at `content`; the table declares what the node means
- [ADR-0221](../../../docs/adr/0221-a-table-names-the-rows-a-commit-touched-and-says-so-after-the-projection-commits.md): what `subscribe` reports and when it fires
- [ADR-0146](../../../docs/adr/0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md): Yjs 14-only persistence decision
- [ADR-0159](../../../docs/adr/0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md): one owner-side SQLite update log and shared attachment seam
