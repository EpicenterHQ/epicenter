---
name: yjs
description: 'Yjs 14 CRDT patterns for Epicenter row documents: @y/y shared types, transactions, updateV2 persistence, row-addressed synchronization, awareness, conflict resolution, and document storage. Use when mentioning Yjs, Y.Doc, CRDTs, collaborative editing, awareness, owner-side SQLite document persistence, row documents, or Yjs providers.'
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

> **Related Skills**: See `workspace-api` for the workspace abstraction built on Yjs.

## Transactions, Origins, And Undo

- Yjs updates are commutative and idempotent. Custom sync and persistence layers should use state vectors instead of inventing ordering guarantees.
- Use `Y.encodeStateVector(doc)` to describe local clocks, then `Y.encodeStateAsUpdateV2(doc, remoteStateVector)` to send only missing updates.
- Persist and transmit bytes from the `updateV2` event. Replay them with `Y.applyUpdateV2(doc, update, origin)`.
- Wrap multi-write user actions in `doc.transact(() => { ... }, origin)`. This reduces observer churn and gives persistence, providers, and undo logic a useful origin.
- Treat transaction origins as the boundary for filtering provider echoes, app-authored operations, and undo tracking.
- Scope `Y.UndoManager` to concrete shared types. Set `trackedOrigins`, tune `captureTimeout`, and call `stopCapturing()` between logically separate commands.
- Use relative positions for collaborative cursor and selection anchors. Raw numeric indexes drift under remote edits.
- `Y.snapshot()` is a historical marker that depends on retained delete history. `Y.encodeStateAsUpdateV2(doc)` is the self-contained checkpoint format.
- Prefer separate top-level docs over Yjs subdocuments unless Epicenter owns the whole provider lifecycle for the subdoc path.

## Row Document Connection

- Yjs is network-agnostic. It supplies CRDT state, state vectors, updates, and awareness behavior, not Epicenter's connection topology, authorization, row lifecycle, or durability contract.
- Row documents have no WebSocket (ADR-0171). Outbound convergence is one automatic HTTP publication of complete state per owed revision; inbound refresh is an explicit `document.pull()` on an open handle, conditional on an opaque authority document version carried as a strong ETag. Do not reintroduce a socket, presence protocol, fanout session, or subscription inventory.
- The authority enforces the shared compound bound (`DOCUMENT_BOUND`: canonical encoded bytes and decoded struct count) exactly on the state produced by joining a submission. The replica premeasures the same bound to keep an over-bound payload off the wire, but the authority's answer is final: an under-bound publication can still be refused once other replicas' accumulation is joined. A refusal names exactly the revision that exceeded the bound; the next local edit supersedes it automatically.
- Publication settles only its captured revision, so acceptance of revision N can never clear N+1. Yjs update idempotency makes a lost acknowledgement safe to retry from durable state; do not retain exact retry bytes or digest-bound receipts for documents.
- Authenticate the bearer into a principal. The account authority derives deterministically from that principal alone (ADR-0092: the principal is the partition and the actor); the route workspace id is a name inside the requester's own partition. There is no catalog, grant, or authority key.
- The structured `(workspaceId, table, rowId)` route address selects one lifecycle-bound document inside the account authority. The address is a name, not a secret or capability. Check row liveness atomically with committed-state load on admission and again on every persisted update.
- Use state-vector exchange followed by incremental `updateV2` messages instead of exchanging complete documents by default.
- Authentication, deterministic authority resolution, and row liveness are three distinct facts with one surface. Row liveness is a lifecycle invariant, not a second per-row authorization system.

## Owner-Side SQLite Persistence

Row documents persist in the Workspace ID's own `store.sqlite3`, in one
`workspace_document_updates` update-log table beside the scalar rows (ADR-0159).
There is no IndexedDB row-document store and no per-runtime provider: the browser
records Worker owns the log in its OPFS SQLite, the Bun host owns it natively,
and the desktop WebView reaches it over the same-origin records route. There is
no official `@y/indexeddb` provider for the Yjs 14 line; do not install or
peer-override `y-indexeddb`.

- The owner side is `createSqliteDocumentLog`: it owns schema, append admission, compaction, capture, and durable deletion. It never holds a live `Y.Doc`.
- Renderer-facing code owns live documents through `createRowDocumentRuntime` over one `createDocumentStore` load/append seam. The renderer capability is exactly `load(address)` and `append(address, updateV2)`; capture, deletion, and compaction policy are never reachable through renderer persistence.
- Attach the `updateV2` listener before hydration can race application writes. Append copied update bytes and expose an invocation-time `whenDurable()` barrier over the persistence tail.
- Apply stored updates with a private hydration origin so replay does not append them again.
- `whenLoaded` means local owner hydration completed. It does not mean remote convergence.
- The owner checks row liveness inside the same transaction as the insert: a late append after row deletion refuses with the address-scoped `DocumentRowAbsentError` instead of resurrecting content.
- Document death happens in the transaction that ends the row's scalar life (local delete, replica lifecycle transitions, fresh-lineage reset, workspace deletion). Deletion is owner-side; a renderer never deletes a log.
- Compact at bounded thresholds by replaying a covered prefix through a fresh `gc: true` document and re-encoding one complete V2 update. Compaction does not remove CRDT modeling costs inside that encoded document.
- Treat corruption, eviction, and transaction failure as storage failures. Do not silently continue with an empty document.

## Core Concepts

### Shared Types

Yjs provides six shared types. You'll mostly use three:

- `Y.Map` - Key-value pairs (like JavaScript Map)
- `Y.Array` - Ordered lists (like JavaScript Array)
- `Y.Text` - Rich text with formatting

The other three (`Y.XmlElement`, `Y.XmlFragment`, `Y.XmlText`) are for rich text editor integrations.

### Client ID

Every Y.Doc gets a random `clientID` on creation. Raw Yjs conflict ordering can
use this id, so concurrent writes to the same raw map key are not "latest
timestamp wins" unless the data structure adds its own timestamp policy.

```typescript
const doc = new Y.Doc();
console.log(doc.clientID); // Random number like 1090160253
```

From dmonad (Yjs creator):

> "The 'winner' is decided by `ydoc.clientID` of the document (which is a generated number). The higher clientID wins."
>
> Source: [GitHub issue #520](https://github.com/yjs/yjs/issues/520)

The actual comparison in source ([updates.js#L357](https://github.com/yjs/yjs/blob/main/src/utils/updates.js#L357)):

```javascript
return dec2.curr.id.client - dec1.curr.id.client; // Higher clientID wins
```

This is deterministic (all clients converge to the same state) but not
intuitive: a later edit can lose. Design document roots around that fact.
Epicenter's scalar tables and KV do not use Yjs or `YKeyValueLww`; runtime-native
SQLite and the scalar row protocol own their convergence semantics.

### Shared Types Cannot Move

Once you add a shared type to a document, **it can never be moved**. "Moving" an item in an array is actually delete + insert. Yjs doesn't know these operations are related.

## Critical Patterns

### 1. Single-Writer Keys (Counters, Votes, Presence)

**Problem**: Multiple writers updating the same key causes lost writes.

```typescript
// BAD: Both clients read 5, both write 6, one click lost
function increment(ymap) {
	const count = ymap.get('count') || 0;
	ymap.set('count', count + 1);
}
```

**Solution**: Partition by clientID. Each writer owns their key.

```typescript
// GOOD: Each client writes to their own key
function increment(ymap) {
	const key = ymap.doc.clientID;
	const count = ymap.get(key) || 0;
	ymap.set(key, count + 1);
}

function getCount(ymap) {
	let sum = 0;
	for (const value of ymap.values()) {
		sum += value;
	}
	return sum;
}
```

### 2. Fractional Indexing (Reordering)

**Problem**: Drag-and-drop reordering with delete+insert causes duplicates and lost updates.

```typescript
// BAD: "Move" = delete + insert = broken
function move(yarray, from, to) {
	const [item] = yarray.delete(from, 1);
	yarray.insert(to, [item]);
}
```

**Solution**: Add an `index` property. Sort by index. Reordering = updating a property.

```typescript
// GOOD: Reorder by changing index property
function move(yarray, from, to) {
	const sorted = [...yarray].sort((a, b) => a.get('index') - b.get('index'));
	const item = sorted[from];

	const earlier = from > to;
	const before = sorted[earlier ? to - 1 : to];
	const after = sorted[earlier ? to : to + 1];

	const start = before?.get('index') ?? 0;
	const end = after?.get('index') ?? 1;

	// Add randomness to prevent collisions
	const index = (end - start) * (Math.random() + Number.MIN_VALUE) + start;
	item.set('index', index);
}
```

### 3. Nested Structures for Conflict Avoidance

**Problem**: Storing entire objects under one key means any property change conflicts with any other.

```typescript
// BAD: Alice changes nullable, Bob changes default, one loses
schema.set('title', {
	type: 'text',
	nullable: true,
	default: 'Untitled',
});
```

**Solution**: Use nested Y.Maps so each property is a separate key.

```typescript
// GOOD: Each property is independent
const titleSchema = schema.get('title'); // Y.Map
titleSchema.set('type', 'text');
titleSchema.set('nullable', true);
titleSchema.set('default', 'Untitled');
// Alice and Bob edit different keys = no conflict
```

## Storage Optimization

### Y.Map vs Scalar Rows

`Y.Map` tombstones retain the key forever. Every `ymap.set(key, value)` creates a new internal item and tombstones the previous one.

Do not use one workspace-wide Y.Doc as the row or KV database. Scalar tables and
KV live in runtime-native SQLite so large record sets remain queryable without
hydrating one CRDT graph into memory. Yjs is reserved for lazy row documents.

```typescript
// Scalar data stays on the row plane.
workspace.tables.notes.set(note);
workspace.kv.set('theme.mode', 'dark');

// Keyed collaborative content may live inside one opened row document.
using messages = workspace.tables.conversations.docs.messages.open(id);
messages.set(message.id, message);
```

Use raw `Y.Map` for bounded, rarely changing structures inside a private
attachment. Use workspace tables and KV for scalar keyed data. Existing
`YKeyValueLww` table and KV code is legacy replacement work; do not extend it or
describe it as the final scalar storage model.

### Epoch-Based Compaction

If your architecture uses versioned snapshots, you get free compaction:

```typescript
// Compact a Y.Doc by re-encoding current state
const snapshot = Y.encodeStateAsUpdateV2(doc);
const freshDoc = new Y.Doc({ guid: doc.guid });
Y.applyUpdateV2(freshDoc, snapshot);
// freshDoc has same content, no history overhead
```

## Common Mistakes

### 1. Assuming Raw "Last Write Wins" Means Timestamps

It doesn't. Raw Yjs conflict ordering can use clientID, not wall-clock time.
Design document state around this or use single-writer keys. Scalar row and KV
conflicts belong to the SQLite row plane, not a Yjs LWW wrapper.

### 2. Using Y.Array Position for User-Controlled Order

Array position is for append-only data (logs, chat). User-reorderable lists need fractional indexing.

### 3. Forgetting Document Integration

Y types must be added to a document before use:

```typescript
// BAD: Orphan Y.Map
const orphan = new Y.Map();
orphan.set('key', 'value'); // Works but doesn't sync

// GOOD: Attached to document
const attached = doc.getMap('myMap');
attached.set('key', 'value'); // Syncs to peers
```

### 4. Storing Non-Serializable Values

Y types store JSON-serializable data. No functions, no class instances, no circular references.

### 5. Expecting Moves to Preserve Identity

```typescript
// This creates a NEW item, not a moved item
yarray.delete(0);
yarray.push([sameItem]); // Different Y.Map instance internally
```

Any concurrent edits to the "moved" item are lost because you deleted the original.

### 6. Working with Raw Y.js Types Outside Their Owning Module

Y.js shared types (`Y.Map`, `Y.Text`, `Y.XmlFragment`, `Y.Array`) are implementation details that should stay behind typed APIs. When consumer code reaches through an abstraction to manipulate raw shared types, it creates coupling that's hard to change later.

**The pattern**: If a module returns Y.js shared types for editor binding (e.g., `handle.asText()` returns `Y.Text`), that's intentional: the consumer needs the live CRDT reference. But if consumer code is *constructing*, *casting*, or *mutating* Y.js types that the owning module should encapsulate, that's a leak.

```typescript
// BAD: consumer reaches through handle to do raw Y.Text mutation
const entry = handle.currentEntry;
if (entry?.type === 'text') {
    handle.batch(() => entry.content.insert(entry.content.length, text));
}

// GOOD: timeline owns the append operation
handle.append(text);
```

```typescript
// BAD: consumer constructs Y.Maps to call an internal CSV helper
import { parseSheetFromCsv } from '@epicenter/workspace';
const columns = new Y.Map<Y.Map<string>>();
const rows = new Y.Map<Y.Map<string>>();
parseSheetFromCsv(csv, columns, rows);

// GOOD: use the handle's write method, which encapsulates CSV parsing
handle.write(csv);  // mode-aware, handles sheet internally
```

### How to Spot Abstraction Leaks

These are code smell indicators that Y.js internals are leaking:

- **Type assertions**: `as Y.Map`, `as Y.Text`, `as Y.XmlFragment` outside the owning module means someone is working with untyped data and forcing it into shape. The typed API is incomplete.
- **Mode branching**: `if (entry.type === 'text') ... else if (entry.type === 'sheet')` in consumer code means the consumer knows about internal content modes that the abstraction should handle.
- **Raw mutations in batch callbacks**: `handle.batch(() => ytext.insert(...))` means the consumer is doing CRDT operations that should be a method on the handle.
- **Internal helper re-exports**: Functions that take `Y.Map<Y.Map<string>>` parameters on a public API force consumers to have raw Y.js references to call them.
- **`ydoc.getArray()`/`ydoc.getMap()` outside infrastructure**: Consumer code accessing the raw Y.Doc to read/write data bypasses the table/kv/timeline APIs.

### The Boundary Rule

Three layers, each with clear Y.js exposure:

```
┌──────────────────────────────────────────────────────┐
│  Consumer Code (apps, features)                      │
│  • Uses row document handles and typed root APIs     │
│  • MAY bind to Y.Text/Y.XmlFragment from as*()      │
│  • NEVER constructs Y.js types                       │
│  • NEVER casts to Y.js types                         │
│  • NEVER calls .insert()/.delete() on raw types      │
├──────────────────────────────────────────────────────┤
│  Format Bridges (markdown, sheet converters)          │
│  • Accepts Y.js types as parameters (they're bridges)│
│  • Converts between Y.js ↔ string/JSON               │
│  • Lives close to the owning module                   │
├──────────────────────────────────────────────────────┤
│  Row Document Internals                               │
│  • Constructs and manages Y.js shared types           │
│  • Owns the Y.Doc layout (array keys, map structure)  │
│  • Exposes typed APIs that hide the CRDT details      │
└──────────────────────────────────────────────────────┘
```

When reviewing code, ask: "Could this consumer do its job with only the typed API?" If yes and it's using raw Y.js types instead, that's a leak worth fixing.

See the article `docs/articles/yjs-abstraction-leaks-cost-more-than-the-abstraction.md` for the full pattern with real examples.

## Debugging Tips

### Inspect Document State

```typescript
console.log(doc.toJSON()); // Full document as plain JSON
```

### Check Client IDs

```typescript
// See who would win a conflict
console.log('My ID:', doc.clientID);
```

### Watch for Tombstone Bloat

If documents grow unexpectedly, check for:

- Frequent Y.Map key overwrites
- "Move" operations on arrays
- Missing epoch compaction or a runtime doc accidentally created with `gc: false`

## References

- [Learn Yjs](https://learn.yjs.dev/) - Interactive tutorials
- [Yjs Documentation](https://docs.yjs.dev/) - API reference
- [Yjs INTERNALS.md](https://github.com/yjs/yjs/blob/main/INTERNALS.md) - How Yjs works internally
- [GitHub issue #520](https://github.com/yjs/yjs/issues/520) - Conflict resolution discussion with dmonad
- [fractional-indexing](https://github.com/rocicorp/fractional-indexing) - Production library
- [YATA paper](https://www.researchgate.net/publication/310212186_Near_Real-Time_Peer-to-Peer_Shared_Editing_on_Extensible_Data_Types) - Academic foundation
- `packages/data/src/store/replica/document-store.ts`: the owner-side Yjs 14 SQLite baseline-plus-tail chain (append, compaction, revisions, refusal)
- `packages/data/src/runtime/row-document.ts`: the runtime-owned `RowDocument` handle, its durable append path, and `pull()`
- `packages/sync/src/document-v3/`: the shared Yjs 14 document bound and its measurement
- [ADR-0171](../../../docs/adr/0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md): automatic HTTP publication and explicit pull
- [ADR-0174](../../../docs/adr/0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md): nullable document cells and bounded live chains
- [ADR-0146](../../../docs/adr/0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md): Yjs 14-only persistence decision
- [ADR-0159](../../../docs/adr/0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md): one owner-side SQLite update log and shared attachment seam
