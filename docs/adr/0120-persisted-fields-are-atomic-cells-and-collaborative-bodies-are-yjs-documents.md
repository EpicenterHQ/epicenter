# 0120. Persisted fields are atomic cells and collaborative bodies are Yjs documents

- **Status:** Accepted
- **Date:** 2026-07-11
- **Relates:** [ADR-0005](0005-child-docs-are-bound-through-the-workspace.md), [ADR-0106](0106-a-child-doc-body-owns-one-layout-the-polymorphic-timeline-is-refused-until-a-product-earns-it.md), [ADR-0107](0107-a-child-doc-text-body-is-a-plain-y-text-the-timeline-array-is-deleted.md)
- **Amended by:** [ADR-0130](0130-records-replacement-starts-a-new-epoch-without-an-online-succession-protocol.md) (records replacement starts a new epoch without shared succession machinery); [ADR-0134](0134-application-data-generations-own-immutable-workspace-namespaces.md) (durable contract changes publish a new application data generation); [ADR-0138](0138-tables-declare-cells-documents-and-blobs-in-one-field-map.md) (one field map declares cells, documents, and blob references)

## Context

Epicenter needs one rule that tells schema authors which values use SQLite cell
replacement and which values need collaborative merge semantics. A configurable
merge policy per field would recreate several synchronization engines inside one
schema. The existing `@epicenter/field` package already provides a closed,
recognizable vocabulary with TypeScript inference, runtime validation, editor
hints, and SQLite storage classes. Row-owned Yjs documents need a similarly
closed format vocabulary without becoming SQLite columns.

## Decision

A record cell is the replacement boundary. Store a value in records when
server-ordered replacement of the whole cell preserves acceptable intent.
Concurrent assignments to different cells compose; concurrent assignments to
the same cell resolve by server acceptance order.

This ADR owns that conflict boundary and the persisted field vocabulary.
[ADR-0123](0123-bounded-metadata-uses-record-authority-merge-sensitive-state-uses-lazy-child-documents.md)
applies it as the placement rule for records and lazy child documents.

Every persisted table column and KV value is authored with the closed `field.*`
vocabulary, optionally wrapped in `nullable(...)`. `field.json(schema)` is the
only structured-value escape hatch. Raw TypeBox schemas remain valid for action
inputs and other non-storage validation, but not as a second persisted-schema
language.

Every column is one atomic value under server-order replacement. The record wire
language has three semantic operations:

```ts
type Operation =
	| {
			kind: 'createRow';
			table: string;
			rowId: string;
			cells: Record<string, JsonValue>;
	  }
	| {
			kind: 'updateRow';
			table: string;
			rowId: string;
			cells: Record<string, JsonValue>;
	  }
	| { kind: 'deleteRow'; table: string; rowId: string };
```

`createRow` materializes an absent row with its complete initial cells; the
schema-blind authority orders and stores it without validating domain
completeness. `updateRow` changes only the named cells of a live row and folds
to a deterministic no-op when the row is absent. `deleteRow` physically removes
a live row and folds to a no-op when it is already absent. A `createRow` whose
identity is already live is a replica invariant violation, never a routine
no-op. The wire forbids `undefined`; within `updateRow`, `null` clears the
named cell. The same row id in the same table and logical database always
names the same row and has exactly one lifetime: normal public creation
generates a fresh UUID internally, and restoring a purged record creates a new
id. Client-generated ids are retained through sync and logical import.

Declared KV values are not record rows. Bounded synchronized preferences live
in the workspace's eager KV Yjs document
([ADR-0093](0093-kv-metadata-belongs-to-the-workspace-kv-namespace.md)), where
a missing or invalid value honestly reads as a fresh default. A deterministic
KV key cannot promise first-creation exclusivity across offline devices, so it
must not ride `createRow`; its last-write-wins document entry carries no row
lifecycle at all.

Content that needs structural or character-level concurrent merging is not a
field. It is declared through a table's `documents` slot and stored as a
separate lazy Yjs document. Applications choose from Epicenter's closed document
capability catalog: plain text, an XML fragment, or validated keyed records.
Each capability owns its Yjs roots, canonical format descriptor, derived format
hash, and typed attachment. Raw Yjs layouts and per-field merge-policy options
are not part of the application schema surface (ADR-0126).

## Consequences

- `field.string`, `field.boolean`, `field.select`, `field.tags`,
  `field.multiSelect`, and `field.json` all share the same sync behavior: the
  complete cell value is replaced. Their distinct kinds earn validation,
  storage, and editor behavior, not separate conflict algorithms.
- The merge unit, not value size or offline availability, determines whether a
  value remains a cell or moves to a child document.
- Arrays in `field.tags`, `field.multiSelect`, and `field.json` do not merge by
  element. Independent contributions belong in independent rows or a Yjs body.
- A generic database editor and import diff can derive widgets from the same
  field schema that generates SQLite storage and validates values.
- Tables and KV share one authoring vocabulary (`field.*`) but not one storage
  plane. Record tables carry the create/update/delete lifecycle, snapshots,
  and server-order conflicts; KV values are last-write-wins entries in the
  eager KV document with defaults on read. Because the KV document is not
  the record wire, a KV schema may be `nullable(...)`: `null` can be a real
  stored preference, while deleting the key means no override exists.
- Honest clients only emit values valid for the active records epoch's exact
  records schema hash. Every synchronized records schema change, wholesale
  rewrite, or restore starts a new records epoch through an administrative
  operation; local indexes and internal storage changes do not. Child-document
  formats evolve under their own format hashes and do not replace records.
  Structurally valid but nonconforming input from a buggy or dishonest client
  remains storable without creating a second cross-version schema path.
- An administrative replacement tool may validate source rows against a
  historical descriptor before invoking a typed transform. That tool owns its
  failure and retention policy; the synchronization protocol does not.
- Existing scalar transcript, note-body, todo-body, and wiki-body columns are
  candidates for a clean move to declared child docs. Existing raw persisted
  TypeBox schemas must move through `field.json` or earn a new closed field kind.

## Considered alternatives

- **Configure `lww`, `set`, `counter`, or `yjs` per field.** Rejected: it creates
  a merge-policy language, several metadata formats, and several snapshot rules.
  A value that is not replaceable scalar metadata needs a different data model.
- **Represent every value in Yjs.** Rejected: raw Yjs map assignments still pick
  one winner, while CRDT history and loading costs remain. Yjs is reserved for
  bodies where its merge semantics carry product value.
- **Permit arbitrary raw TypeBox schemas in persisted tables.** Rejected: a
  second schema language forces fallback storage, validation, editor, migration,
  and sync paths. `field.json` is the explicit atomic escape hatch.
- **Encode terminal deletion as a reserved ordinary cell.** Rejected: deletion
  has identity semantics and earns one explicit operation.
