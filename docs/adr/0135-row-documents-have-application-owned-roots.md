# 0135. Row documents have application-owned roots

- **Status:** Accepted
- **Date:** 2026-07-16
- **Amends:** [ADR-0106](0106-a-child-doc-body-owns-one-layout-the-polymorphic-timeline-is-refused-until-a-product-earns-it.md) and [ADR-0107](0107-a-child-doc-text-body-is-a-plain-y-text-the-timeline-array-is-deleted.md) only for the permanent row-document root layout
- **Amended by:** [ADR-0166](0166-data-document-sync-and-agent-replace-workspace.md) and [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md) (application-owned Yjs roots remain; record handles and bounded live chains replace the Workspace opener, owner, persistence, and protocol-major claims)
- **Relates:** [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md), [ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md), [ADR-0133](0133-row-authority-stores-documents-as-sequence-addressed-update-logs.md), [ADR-0134](0134-replicas-store-confirmed-state-and-compacted-row-intents.md)

## Context

Selecting a text or rich-text layout per table makes document format a
permanent table contract. That requires declarations, authority pins,
admission checks, ordered contract outcomes, replica metadata,
baseline-acquisition sections, and migration rules. Reserving one universal
`content` root removes the format choice but still makes Epicenter own an
otherwise arbitrary application namespace.

[Yjs 14 release candidates](https://github.com/yjs/yjs/releases/tag/v14.0.0-rc.24)
replace the older separate `Y.Text` and `Y.XmlFragment` class surface with one
[unified shared type](https://github.com/yjs/yjs/blob/v14.0.0-rc.24/src/index.js).
Its `Doc.get(key, name?)` method returns the same integrated `Type` for repeated
access to one key. The v14
[CodeMirror binding](https://github.com/yjs/y-codemirror.next/blob/6a981e1794b3592a94f3d3b4fc620f14c5adaf11/src/index.js)
and
[ProseMirror binding](https://github.com/yjs/y-prosemirror/blob/8c93eb5e1da4704200f87bbf5722b70eb69fba16/ARCHITECTURE.md)
accept that shared type and interpret its delta for their editor model.
Epicenter therefore does not need to own either editor formats or root names.

## Decision

Every ordinary row owns one latent Yjs document with no reserved roots. The
application creates and reuses arbitrary top-level roots by name:

```ts
using document = await workspace.tables.notes.document.open(row.id);

const editor = document.get('editor');
const comments = document.get('comments');
```

Root names and interpretations are durable application schema. Two modules
that compose into one row document must coordinate their names. Renaming a
populated root is an application-owned conversion, not a workspace protocol
upgrade. Epicenter does not declare, validate, version, reserve, enumerate, or
interpret roots.

The singular `table.document` capability makes the document subordinate to its
table row without turning row snapshots into resource handles. Its `open(rowId)`
method checks current row liveness, hydrates confirmed plus sealed/open document
state, and returns a cached lease. The workspace exposes that lease as a
deliberately native-shaped `RowDocument`, not the raw Yjs `Doc`:

```ts
type RowDocument = {
	get: Y.Doc['get'];
	/**
	 * Groups application-authored changes into one local Yjs transaction.
	 *
	 * This signature deliberately restates rather than derives
	 * `Y.Doc['transact']`: Yjs's third `local` parameter belongs to provider
	 * infrastructure, so application code must not control it.
	 *
	 * @example
	 * document.transact(() => {
	 * 	editor.insert(0, 'Hello');
	 * }, 'editor');
	 */
	transact<TValue>(
		callback: (transaction: Y.Transaction) => TValue,
		origin?: unknown,
	): TValue;
	/**
	 * Waits until the SQLite transaction containing every local update observed
	 * before this call has committed.
	 *
	 * Persistence starts automatically. Normal editing does not await this;
	 * use it only when another operation requires a durable local boundary.
	 */
	whenDurable(): Promise<void>;
	[Symbol.dispose](): void;
};
```

`get` derives the exact upstream signature, including the optional type name,
instead of copying it. `transact` preserves the native callback, origin, and
return-value shape but deliberately omits Yjs's third `local` parameter. Every
application transaction is local; provider application remains workspace
infrastructure. The JSDoc must remain on the eventual public method because the
missing third parameter is a deliberate authority boundary, not an incomplete
copy of the upstream signature.

Persistence starts automatically for every emitted update. `whenDurable()` is
an optional observation barrier, not the command that begins persistence. It
waits until every local document update observed before the call has committed
in the canonical workspace database. The browser OPFS runtime uses SQLite's
DELETE journal with `synchronous = EXTRA`, not WAL, so no WAL checkpoint exists
on that path. The method does not wait for remote authority acceptance. Most
editor code never calls it; it exists for operations that must not proceed from
memory-only state.

SQLite is the canonical local persistence boundary in this destination. Row
documents do not attach `y-indexeddb`, and browser IndexedDB is not a second
durability owner. Existing IndexedDB-backed workspace paths are migration
sources, not part of this contract.

`open(rowId)` is asynchronous because the returned handle is ready rather than
half-hydrated. It checks row liveness, acquires the cached lease, loads confirmed
plus pending state from SQLite, and installs update capture before resolving.
It does not wait for remote convergence.

`[Symbol.dispose]()` releases this acquisition's cached lease. It does not
wait for durability, cancel an already observed update, or destroy canonical
state. The workspace persistence owner finishes queued commits independently;
the cache owns eventual Yjs document destruction after the last lease closes
or the row lifetime ends. Retaining and mutating a root after its lease closes
or its row dies is unsupported; the persistence owner rechecks row liveness and
cannot recreate a deleted row.

The returned values are real Yjs v14 `Type` instances. Editors and other
application code may use their native shared-type APIs. A real type retains a
`.doc` backpointer, so raw reach-through remains possible but unsupported. The
handle itself does not expose `destroy`, `load`, `share`, `clientID`, update
application, provider events, or a raw `Y.Doc` accessor. Epicenter owns
document construction, identity, hydration, update capture, synchronization,
durability, revocation, and destruction. The application owns the
collaborative layout inside that lifetime.

One row document may contain several independently interpreted roots. The
unified runtime type does not make those interpretations interchangeable.
CodeMirror may treat one root as linear text while ProseMirror treats another
as a structured tree. Changing the interpretation of a populated root remains
an application conversion and replacement.

There is no document declaration on `defineTable`, no per-table document kind,
and no authority document-contract map. An empty document persists no
`documents` row. One opaque document update may affect any number of roots;
the authority neither inspects nor validates its root layout.

The whole row document is bounded interactive CRDT state under ADR-0131's
encoded canonical document maximum. Root composition does not create separate
size allowances. Media and other large payloads belong in the filesystem or
blob plane. If a local edit cannot be compacted into a valid document below the
maximum, its SQLite persistence fails, the handle is poisoned, and the caller
must reopen it. Garbage collection reduces deleted history but cannot make
unbounded live content admissible.

Root names carry no workspace version prefix. Yjs dependency, update encoding,
and document bounds belong to the workspace protocol major. This greenfield
runtime selects Yjs 14 and pins an exact release-candidate version until stable
is adopted deliberately. A build implements exactly one active wire major and
refuses different majors before folding. A future incompatible encoding change
updates the protocol constant and physical storage migration together; it does
not create versioned roots, negotiation objects, or a permanent previous-major
path.

## Consequences

- The document declaration API, contract identifiers, authority contract pins,
  contract protocol entries, contract tables, and contract
  baseline-acquisition sections disappear.
- `RowBody`, `body.binding`, the reserved `content` root, text and rich-text
  handles, active modes, and conversion APIs disappear.
- Applications can compose independent collaborative features inside one row
  without negotiating one platform-owned container layout.
- Direct `Y.Doc` access remains refused. The public surface grants layout
  composition without transferring provider or lifecycle control.
- Every ordinary row is document-capable at no storage cost while empty. The
  reserved workspace KV row remains scalar-only.
- Two releases can still disagree about root names or interpretations. That is
  an application compatibility error, not sync admission or a platform
  migration system.
- One row cannot become a general blob container by adding roots. Exceeding the
  document maximum fails local durability instead of creating chunks or a
  permanently unsendable intent.
- Adopting a release candidate accepts upstream API churn before Yjs 14 stable.
  Exact dependency pinning contains that risk without preserving a Yjs 13 path.

## Considered alternatives

- **Reserve one `content` root.** Rejected because the opaque sync and storage
  layers do not depend on that name, while applications must either accept the
  platform's arbitrary namespace or compose another namespace beneath it.
- **Expose the raw Yjs `Doc`.** Rejected because root composition does not
  require transferring document identity, provider events, update application,
  loading, or destruction to application code.
- **Use `Pick<Y.Doc, 'get' | 'transact'>`.** Rejected because upstream
  `transact` also exposes the provider-facing `local` flag. Only `get` is
  derived exactly; the public transaction method fixes application writes as
  local.
- **Declare root names on `defineTable`.** Rejected because it recreates a
  release-level layout contract that the schema-blind authority neither needs
  nor validates.
- **Give each root an independent document.** Rejected because roots compose
  within one row identity, liveness rule, transaction boundary, and deletion.
