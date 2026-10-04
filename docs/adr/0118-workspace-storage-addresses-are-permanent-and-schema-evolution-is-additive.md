# 0118. Workspace rows are permanent independently editable cells

- **Status:** Proposed
- **Date:** 2026-07-10
- **Supersedes:** [ADR-0006](0006-schema-evolution-keeps-the-version-tuple-and-refuses-repair-apis.md) (positional row versions and migrate-on-read)
- **Amends:** [ADR-0005](0005-child-docs-are-bound-through-the-workspace.md) (document keys are permanent storage addresses), [ADR-0094](0094-the-connection-is-the-boot-decision-one-connect-call.md) (one local handle may attach sync after authentication)
- **Relates:** [ADR-0106](0106-a-child-doc-body-owns-one-layout-the-polymorphic-timeline-is-refused-until-a-product-earns-it.md), [ADR-0107](0107-a-child-doc-text-body-is-a-plain-y-text-the-timeline-array-is-deleted.md)

## Context

The current table runtime stores each complete row as one timestamped value in
`YKeyValueLww`. `defineTable(v1, v2).migrate(...)` stamps that value with a
positional `_v` and migrates it on read.

This cannot protect a newer field from an offline old writer. The old client may
never have received the newer row, so its local newer-writer guard has no fact
to inspect. When it later replaces the whole row, the physical conflict erases
cells it never knew.

Schema hashes, compatibility branches, epochs, lenses, or stronger guards do
not change that write boundary. The safe boundary is a write that physically
cannot address unknown cells.

## Decision

**A workspace stores each row as presence plus independently editable typed
cells. Application code sees required-by-default valid rows, and a redesigned
concept gets a new storage key instead of a runtime migration.**

### Physical storage

Each table owns one row-presence map and one root map per declared cell:

```txt
Y.Doc <workspace identity>
  Y.Map "table:notes:rows"
    <row-id> -> true
  Y.Map "table:notes:cell:title"
    <row-id> -> value
  Y.Map "table:notes:cell:pinned"
    <row-id> -> value
```

The row ID is the map coordinate. The reserved `id` schema validates that
coordinate and does not create another physical cell.

The normal table verbs are `insert`, `patch`, and `delete`:

- `insert(id, cells)` establishes presence, requires every semantically
  required cell, and writes supplied cells. It refuses a locally present row.
  Concurrent inserts may still converge into one cell-wise result and do not
  promise uniqueness. Whether reinsertion clears known optional cells that were
  not supplied remains a deferred product decision.
- `patch(id, cells)` changes only named physical cells. It may remove optional
  cells, but local callers cannot remove required cells. A patch concurrent
  with deletion may leave hidden cell values but cannot recreate presence.
- `delete(id)` removes presence and every cell known to that client in one
  transaction. Unknown newer cells and concurrent late writes may remain
  hidden. This is canonical deletion, not secure erasure.

No application verb rewrites a cell the binary does not declare. There is no
whole-row `set`, replace, upsert, `bulkSet`, `clear`, or generic migration write.

Same-cell conflicts use the replication engine's deterministic convergence.
The API does not claim that wall-clock latest wins. Local transactions batch
writes and observer notification; they do not provide distributed ACID.

### Requiredness and issues

Physical absence and semantic requiredness are separate.

```ts
const notes = defineTable(
	{
		id: field.string<NoteId>(),
		title: field.string(),
		pinned: field.boolean(),
		subtitle: field.string(),
	},
	{ optional: ['subtitle'] },
);
```

Fields are required by default. The parent-level `optional` list names the
exceptions and autocompletes declared non-ID fields. The healthy row type is:

```ts
type Note = {
	id: NoteId;
	title: string;
	pinned: boolean;
	subtitle?: string;
};
```

Raw replicated storage may lack any cell or contain an invalid value. Local
writes validate immediately. Normal reads classify storage into two lanes:

```txt
valid and complete      -> typed rows
missing or invalid      -> typed issues with valid partial cells and raw problems
```

Invalid bytes remain replicated. Reads never coerce, repair, delete, or replace
them. Repair uses ordinary validated patches or application actions, not raw
Yjs mutation.

### Defaults

Tables have no behavior-bearing read default. Absence reads as absence or, for
a required field, a missing-cell issue. A JSON Schema `default` annotation may
remain inert authoring metadata, but Workspace and Matter conformance readers do
not apply it.

Applications write real initial values in inserts or actions. KV keeps its
factory defaults because its getter intentionally promises a total preference
value and may replace an absent or invalid preference. Table rows are user data
and do not make that promise.

General scalar `nullable()` is removed from the final table API. Absence is the
empty-cell state. Explicit null remains possible only when null is genuine
domain data inside an intentional JSON schema.

### Permanent addresses and the contract lock

Except for the reserved `id` coordinate, TypeScript object keys are
human-readable storage keys. Table keys, cell keys, KV keys, and document keys
are permanent within a workspace identity. A published key is never renamed,
reused, or reinterpreted.

Each application commits a generated contract lock containing active and
retired addresses, value schemas, requiredness, reference targets, and document
layouts. The lock:

- permits additive compatible declarations;
- requires every field added to a published Workspace table to be optional;
- rejects key reuse, incompatible schema changes, requiredness changes,
  reference-target changes, and document-layout changes;
- lets a retired declaration leave the active TypeScript API while reserving
  its key against future reuse.

The lock is a repository release guard. It is not a downloaded schema,
replicated compatibility catalogue, runtime negotiation mechanism, or proof
against a developer changing meaning without changing shape.

### Evolution and redesign

The normal path is additive:

- add an optional cell;
- add a table, KV key, or child-document key;
- add or rebuild a disposable projection.

The redesign ladder is deliberately surgical:

```txt
changed value concept       -> companion cell key
changed table concept       -> replacement table key in the same workspace
changed document layout     -> replacement document key
wholesale redesign/compact  -> new workspace identity
```

A replacement table such as `notesRebuilt` requires no replicated head pointer.
The application binary decides which table it reads and writes. Old clients may
continue writing the old table; those edits remain recoverable but never merge
automatically into the replacement.

An optional importer is application-owned. It reads old data under its old
contract, proposes writes through the new application's validated operations,
reports omissions, and writes only deliberately. AI may assist through the same
validated operations. Small applications may ship no importer.

### Documents, references, and projections

Large or collaboratively edited bodies remain separate top-level Y.Docs opened
on demand. A document key owns one permanent layout. A new layout gets a new
document key.

`touch: 'updatedAt'` is best-effort, non-atomic metadata. It may lag or be
absent, never restores a deleted row, and is not authoritative edit history.

References preserve direction, not integrity. `field.reference('folders')`
identifies where a target should be found. It enables search, navigation,
reverse inspection, validation in actions, and deliberate repair. It does not
promise target existence, foreign-key enforcement, uniqueness, locks, cascades,
or automatic repair.

Workspace SQLite and Markdown materializers, search indexes, and embeddings are
disposable projections. Matter vault Markdown is Matter's source of truth and
is not a Workspace materializer.

Matter continues to share the present-value `field.*` wire forms and the
required-by-default plus `optional` mental model. Matter owns its own
completeness and evolution policy because `matter.json` travels beside its
data. No shared record-contract wrapper or stable Matter table ID is introduced
without a concrete producer.

### Engine and scale boundary

Yjs is the first engine, not the public contract. Raw Yjs stays inside Workspace
storage and deliberate editor bindings. The typed contract remains implementable
by another deterministic full-replica engine.

Every device receives the complete replica. Blobs, large provider mirrors,
analytics, caches, search indexes, and embeddings stay outside it. Realistic
mobile memory, cold reload, encoded update size, and delete/reinsert churn are
release gates. If Yjs fails the agreed device and data budget, Epicenter replaces
the engine rather than silently weakening the offline product promise.

## Consequences

- An old client patching `title` cannot erase a newer `pinned` cell.
- Initial tables retain useful required TypeScript properties.
- New fields cannot become storage-required on an existing published table.
  New application actions may require them, a backfill may populate them, or a
  replacement table may establish a new invariant.
- Missing and invalid rows remain recoverable without infecting every healthy
  application row with `undefined`.
- Dead declarations can leave the active API while their addresses remain
  reserved in the contract lock.
- The runtime loses `_v`, migrate-on-read, whole-row LWW, clock-based winner
  claims, newer-writer guards, and whole-row replacement APIs.
- The initial physical-layout change is breaking. Old and new engines do not
  co-write one workspace identity. Valuable existing data moves explicitly.

## Considered alternatives

- **Harden whole-row migrations.** Rejected: an offline client cannot guard
  against a newer row it has never received.
- **Make every application field optional.** Rejected: this leaks raw storage
  uncertainty through every caller and weakens Matter's useful model.
- **Apply read-time table defaults.** Rejected: stored and observed values
  diverge, projections need fallback policy, and default changes reinterpret
  old data without writes.
- **Put optionality inside `field.*`.** Rejected: requiredness belongs to the
  containing record, not the present-value schema.
- **Add explicit storage IDs beside every object key.** Rejected: two names for
  every address add indirection and can drift independently.
- **Use epochs or a mutable head document.** Rejected: every client becomes a
  coordinator and stale offline edits accumulate on both sides of the pointer.
- **Adopt schema branches, lenses, and a compatibility catalogue.** Rejected:
  Epicenter refuses automatic bidirectional compatibility across semantic
  redesigns.
- **Retire deleted row IDs forever.** Rejected: a grow-only deleted-ID registry
  complicates restore and still cannot promise secure erasure.

## Deferred decisions

- Whether adding a member to `select` or `multiSelect` is a permitted validation
  exception. Old binaries preserve the bytes but place affected rows in issues.
- The exact release-gate device floor, row count, cell width, and churn budget.
- Whether deterministic-ID applications prefer known-cell clearing on reinsert
  after the first vertical implementation exercises the behavior.
