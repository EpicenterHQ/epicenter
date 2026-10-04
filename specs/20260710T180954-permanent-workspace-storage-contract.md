# Permanent per-cell Workspace storage

**Date**: 2026-07-10
**Status**: In Progress
**Owner**: Epicenter
**Supersedes**: `specs/20260107T005800-workspace-guid-and-epochs.md`, `specs/20260124T125300-workspace-schema-versioning.md`, `specs/20260124T162638-stable-id-schema-pattern.md`, `specs/20260423T070000-head-doc-epoch-strategy.md`

## One sentence

A Workspace stores rows as presence plus independently merged cells, exposes
required-by-default valid rows and repairable issues, and handles redesigns by
adding replacement keys rather than migrating storage in place.

## How to read this spec

Read first:

- Target API
- Storage model
- Evolution ladder
- Implementation waves
- Verification

Read when changing the architecture:

- Decisions
- Edge cases
- Open questions

The durable decision is [ADR-0118](../docs/adr/0118-workspace-storage-addresses-are-permanent-and-schema-evolution-is-additive.md).
This spec is execution scaffolding and is deleted when the clean break lands.

## Current state

`defineTable(v1, v2).migrate(...)` stores a complete row plus positional `_v`
as one timestamped `YKeyValueLww` value. `update(id, partial)` reads the row,
merges the partial in memory, and writes the entire row again.

```txt
Y.Array "table:notes"
  YKeyValueLww entry
    key: note id
    value: { id, title, every other field, _v }
    timestamp: wall-clock LWW metadata
```

An offline old writer cannot detect a newer schema it has never received. Its
whole-row write may therefore erase newer cells. The write boundary, not the
migration function, is the correctness failure.

Relevant owners:

- `packages/workspace/src/document/define-table.ts`: positional schemas and
  `.migrate(...)`.
- `packages/workspace/src/document/table.ts`: `_v`, whole-row parsing and table
  verbs.
- `packages/workspace/src/document/y-keyvalue/y-keyvalue-lww.ts`: timestamped
  whole-value conflict resolution.
- `packages/workspace/src/document/nullable.ts`: explicit null used because
  current whole rows cannot omit keys.
- `packages/matter-core/src/core/contract.ts`: Matter's parent-level
  required-by-default policy.
- `packages/matter-core/src/core/conformance.ts`: visible missing and invalid
  cell states.

## Target API

```ts
import { field } from '@epicenter/field';
import {
	attachRichText,
	defineKv,
	defineTable,
	defineWorkspace,
} from '@epicenter/workspace';

const folders = defineTable({
	id: field.string<FolderId>(),
	name: field.string({ minLength: 1 }),
});

const notes = defineTable(
	{
		id: field.string<NoteId>(),
		folderId: field.reference<FolderId>('folders'),
		title: field.string(),
		pinned: field.boolean(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
		subtitle: field.string(),
		trashedAt: field.instant(),
	},
	{ optional: ['folderId', 'subtitle', 'trashedAt'] },
).docs({
	body: {
		layout: attachRichText,
		touch: 'updatedAt',
	},
});

const view = defineKv(field.select(['list', 'grid']), () => 'list');

export const honeycrisp = defineWorkspace({
	id: 'honeycrisp',
	tables: { folders, notes },
	kv: { view },
});
```

The `optional` list:

- autocompletes every declared non-ID field;
- rejects unknown keys;
- does not require `as const`;
- controls semantic requiredness and inferred ready-row types;
- does not claim physical cell presence.

Target inference:

```ts
type Note = InferTableRow<typeof notes>;

// Equivalent:
type Note = {
	id: NoteId;
	title: string;
	pinned: boolean;
	createdAt: InstantString;
	updatedAt: InstantString;
	folderId?: FolderId;
	subtitle?: string;
	trashedAt?: InstantString;
};
```

Writes:

```ts
const workspace = honeycrisp.open(runtime);
await workspace.whenLoaded;

workspace.tables.notes.insert(noteId, {
	title: 'Untitled',
	pinned: false,
	createdAt: InstantString.now(),
	updatedAt: InstantString.now(),
});

workspace.tables.notes.patch(noteId, {
	title: 'A better title',
	updatedAt: InstantString.now(),
});

workspace.tables.notes.patch(noteId, {
	folderId: undefined,
});

workspace.tables.notes.delete(noteId);
```

Rules:

- `insert` requires every required cell and accepts optional cells.
- `patch` writes only supplied cells.
- Required cells cannot be cleared by typed local code.
- Optional cells clear through an explicit `undefined` property.
- `delete` removes row presence and every declared cell known to that client.
- Concurrent insert is not distributed uniqueness.
- No normal API exposes whole-row replace, upsert, `bulkSet`, or `clear`.

Reads preserve both useful TypeScript and bad remote data:

```ts
type RowIssue<TRow extends { id: string }> = {
	id: TRow['id'];
	partial: Partial<TRow>;
	problems: CellProblem[];
};

type CellProblem =
	| { kind: 'missing'; field: string }
	| { kind: 'invalid'; field: string; raw: unknown };

table.get(id); // Result<Note | null, RowIssue<Note>>
table.scan();  // { rows: Note[]; issues: RowIssue<Note>[] }
```

`partial` contains every present and valid declared cell. Invalid bytes remain
stored and appear on the problem. Reads never repair or coerce. Application
actions and trusted typed patches own repair.

## Field and Matter boundary

`@epicenter/field` describes present values only:

```ts
field.string<TBrand?>(options?)
field.reference<TBrand?>(targetTable, options?)
field.url(options?)
field.number(options?)
field.integer(options?)
field.boolean(options?)
field.date(options?)
field.instant(options?)
field.datetime(options?)
field.select(values, options?)
field.multiSelect(values, options?)
field.tags(options?)
field.json(inner)
```

Value refinements and inert annotations may remain portable. No table reader
applies JSON Schema `default`. New-row values are explicit application writes.
KV retains its factory default because KV promises a total preference value.

Matter keeps its current human-readable shape:

```json
{
	"fields": {
		"title": { "type": "string" },
		"pinned": { "type": "boolean" },
		"subtitle": { "type": "string" }
	},
	"optional": ["subtitle"]
}
```

Workspace and Matter share field wire forms, recognition, validation, and the
required-by-default plus optional-exceptions mental model. They do not share an
extra `defineRecordContract` abstraction or identical evolution rules.

Matter owns YAML-null handling, completeness, repair UI, and the freedom to add
a required field that deliberately marks existing documents incomplete. A
published Workspace cannot do that because old compiled clients continue to
create rows without the new field.

Matter folder names remain table identity until a real cross-vault or
rename-surviving reference producer earns a stable hidden ID.

## Storage model

```txt
Y.Doc guid = <workspace identity>
|
+-- Y.Map "table:notes:rows"
|   +-- <note-id> -> true
|
+-- Y.Map "table:notes:cell:title"
|   +-- <note-id> -> "Hello"
|
+-- Y.Map "table:notes:cell:pinned"
|   +-- <note-id> -> false
|
+-- Y.Map "table:notes:cell:updatedAt"
|   +-- <note-id> -> "2026-07-10T...Z"
|
+-- Y.Map "kv"
    +-- "view" -> "list"

Separate Y.Doc guid = <workspace>.<table>.<row-id>.<document-key>
+-- layout-owned shared types
```

One root map per cell avoids the concurrent nested-map creation race. Two
clients may concurrently create the same row presence coordinate while their
different cells still merge into the same maps.

Presence gates reads. A cell whose row ID is absent from the presence map is an
orphan: preserved, invisible, and potentially re-exposed only by explicit
reinsertion.

Yjs is the first engine, not the contract. Direct-Yjs tests pin the facts the
design depends on. Mobile benchmarks decide whether the engine is viable.

### Wave 0 evidence

`per-cell-yjs-convergence.test.ts` now pins six raw Yjs behaviors in both merge
orders:

- disjoint cell patches both survive;
- same-cell patches converge independently of arrival order;
- a concurrent set survives deletion of the previously observed value;
- a late cell patch does not restore row presence;
- explicit reinsertion restores presence and reveals a retained late cell;
- concurrent inserts preserve disjoint cells.

`per-cell-full-replica.bench.ts` compares current whole-row YKV storage with one
presence map plus 12 root cell maps. These are Bun/macOS process measurements,
not iPhone acceptance results:

| Rows / churn | Layout | Insert | Churn | RSS after insert | RSS after churn | Encoded after churn | Cold reload |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10K / 20K | Whole row | 47 ms | 1,171 ms | 73.34 MB | 129.66 MB | 2.74 MB | 28 ms |
| 10K / 20K | Per cell | 62 ms | 62 ms | 126.53 MB | 229.52 MB | 6.72 MB | 90 ms |
| 50K / 100K | Whole row | 576 ms | 29,593 ms | 232.73 MB | 557.52 MB | 13.77 MB | 120 ms |
| 50K / 100K | Per cell | 319 ms | 301 ms | 587.88 MB | 997.30 MB | 33.71 MB | 582 ms |

The proposed layout makes targeted churn roughly two orders of magnitude faster
at 50K rows, but costs about 2.5 times the encoded bytes and substantially more
initial and reload memory. Process RSS varies between runs because the allocator
does not return memory deterministically, so the table is directional rather
than a stable device budget. The 50K proxy is a warning, not a pass. An actual
supported-device run and product budget remain blocking evidence before Yjs is
accepted as the record engine.

## Permanent keys and contract lock

The TypeScript object key is the storage key except for the reserved row `id`
coordinate. Human-readable keys use durable domain names and remain permanent
within one workspace identity.

A generated checked-in lock records:

```txt
workspace identity
active table, cell, KV, and document addresses
retired addresses
present-value schemas and refinements
requiredness
reference targets
document layouts
```

The lock permits compatible additions and reserves retired keys without keeping
dead declarations in the active TypeScript API. It rejects accidental renames,
reuse, type or meaning changes visible in the schema, requiredness changes,
reference-target changes, and layout changes.

The lock does not negotiate at runtime, download schemas, coordinate clients,
or detect a human meaning change that preserves the same shape.

## Evolution ladder

```txt
rename, retype, split, or merge a value
  -> companion cell key

redesign a table concept
  -> replacement table key in the same workspace

redesign a child-document layout
  -> replacement document key

redesign the whole application or compact history
  -> new workspace identity
```

New fields on a published Workspace table must be optional. A newer action may
still require that field for its own inserts. A deliberate backfill may populate
historical rows. If the application cannot function with holes, a replacement
table importer establishes the stronger invariant.

A replacement table needs no mutable epoch or replicated head. The application
binary decides which key it reads and writes. Old clients may continue writing
the old table. Their edits remain recoverable and may be deliberately imported,
but never merge automatically into the replacement.

Import is application-owned and optional. It reads old data under the old
contract, proposes validated new operations, reports omissions, and writes only
deliberately. AI uses those same operations and never mutates raw CRDT storage.

## Decisions

| Decision | Class | Choice | Reason |
| --- | --- | --- | --- |
| Physical conflict boundary | Evidence | One map per cell | Direct Yjs tests must prove disjoint-cell preservation in both merge orders. |
| Requiredness | Coherence | Required by default, parent `optional` list | Preserves strong typed rows while accepting sparse physical storage. |
| New published fields | Coherence | Optional only | Old compiled clients cannot supply a field they do not know. |
| Table defaults | Coherence | Never applied by readers | Stored and observed user data remain the same. |
| KV defaults | Evidence | Keep factory defaults | Existing KV intentionally promises total preference reads. |
| Breaking table redesign | Coherence | Replacement table key | Avoids a replicated head or epoch protocol. |
| Storage identity | Taste under constraints | Human-readable object keys | Avoids two names per field; contract lock makes drift visible. |
| Engine | Deferred by evidence | Yjs first | Mobile benchmark is the falsifier. |

## Edge cases

### Old and new clients patch different cells

Both values survive because the clients write different root maps.

### Delete races with a late patch

The patch may survive in a cell map, but row presence remains absent. The row
does not reappear until an explicit insert.

### Concurrent inserts use the same ID

Presence converges and disjoint cells form one union. Applications still use
generated IDs to avoid accidentally combining distinct entities.

### Invalid remote cell

The row enters the issues lane. Its valid cells remain typed in `partial`; the
invalid bytes remain available for repair.

### New required application rule

The storage field remains optional. New actions require it, historical rows are
backfilled or prompted, and a truly mandatory redesign uses a replacement
table.

### Old client after replacement-table cutover

It writes only the old table. New code does not silently merge those edits. A
legacy view or explicit importer may surface them.

## Open questions

1. **Enum-member additions**
   - Option A: forbid every validation change.
   - Option B: allow adding members because old readers preserve the raw value
     in issues until they update.
   - Recommendation: defer until the product owner chooses whether temporary
     old-client issue classification is acceptable.

2. **Reinsert clearing**
   - Option A: inserting an absent ID clears known optional cells that were not
     supplied, making known state deterministic.
   - Option B: retained cells may reappear on restore.
   - Recommendation: exercise both in the first vertical app before locking the
     public behavior.

3. **Mobile release budget**
   - Choose the oldest supported iPhone-class device, row count, average cell
     width, and churn count.
   - The benchmark reports evidence but cannot choose the product budget.

4. **Matter table identity**
   - Keep folder-name identity until cross-vault or rename-surviving references
     have a live producer.

## Implementation waves

### Wave 0: Prove the physical model

- [x] Pin direct-Yjs convergence facts in durable tests, including both merge
  orders.
- [x] Benchmark one presence map plus one root map per cell against current
  whole-row storage.
- [x] Measure memory, cold reload, encoded update size, and patch/delete/reinsert
  churn.
- [ ] Choose the mobile release budget before building the contract lock or
  migrating applications.

Checkpoint: Yjs passes the chosen full-replica budget, or the record engine is
reopened while the semantic contract remains.

### Wave 1: Build definitions and internal storage

- [ ] Add `defineTable(fields, { optional })` inference and compile-time errors.
- [ ] Build the internal presence-plus-cell-map storage owner.
- [ ] Validate inserts and patches locally.
- [ ] Classify ready rows and issues without repair-on-read.
- [ ] Keep the new storage path internal and unexported until its behavior is
  proven.

### Wave 2: Build one vertical Workspace

- [ ] Expose `insert`, `patch`, `delete`, `get`, and `scan` on one test
  Workspace.
- [ ] Keep child documents separate and type `touch` from instant fields.
- [ ] Exercise local persistence, later sync attachment, invalid values, delete,
  reinsert, and issue repair.
- [ ] Resolve reinsert semantics from observed product behavior.

### Wave 3: Build the release guard

- [ ] Generate the contract lock from the vertical Workspace.
- [ ] Permit optional additions and explicit retirement.
- [ ] Reject incompatible changes without runtime schema negotiation.

### Wave 4: Move Matter and projections

- [ ] Reuse the field and cell-state vocabulary without adding a record wrapper.
- [ ] Keep Matter required by default with `optional` exceptions.
- [ ] Remove behavior-bearing table-default assumptions from SQLite, Markdown,
  and search projections.

### Wave 5: Move applications

- [ ] Replace whole-row writes with intentional inserts and patches.
- [ ] Replace scalar `nullable()` with optional cells or genuine JSON null.
- [ ] Change workspace identities wherever the physical engine has existing
  persisted data that cannot co-write safely.
- [ ] Add replacement tables or importers only for demonstrated data value.

### Wave 6: Stop importing the old path

- [ ] Route every in-repo caller through the new table runtime while leaving the
  old files on disk.

### Wave 7: Verify

- [ ] Run package and repository typechecks.
- [ ] Run focused and full tests.
- [ ] Run one app smoke test and the release-gate benchmark.
- [ ] Confirm repository searches find no live old-path imports.

Rollback remains an import flip or revert because the old files still exist.

### Wave 8: Delete the old promise

- [ ] Delete `_v`, version tuples, `.migrate`, migrate-on-read,
  `YKeyValueLww` table storage, wall-clock table winner logic, newer-writer
  guards, whole-row verbs, and obsolete nullable tests.
- [ ] Remove old fixtures, examples, exports, and documentation.
- [ ] Accept ADR-0118 and delete this completed spec.

## Verification

Wave 0 commands:

```bash
bun run --filter @epicenter/workspace test
bun run --filter @epicenter/workspace typecheck
bun run --filter @epicenter/workspace bench:per-cell
```

The benchmark is a report, not a flaky threshold assertion. Its output records:

```txt
row count and cell count
churn operation count
insert time
churn time
heap delta
encoded update bytes before and after churn
cold reload time and heap delta
```

## Success criteria

- [x] An old-client title patch and new-client pinned patch survive in both sync
  orders.
- [x] A late patch never restores row presence.
- [x] Explicit reinsert is the only tested operation that restores presence.
- [x] Concurrent inserts converge without hiding a disjoint cell.
- [ ] Required and optional inference is proven under strict TypeScript settings.
- [ ] Invalid remote values remain recoverable in a typed issues lane.
- [ ] The mobile release budget is written and measured.
- [ ] No public runtime migration, epoch, lens, or compatibility catalogue is
  introduced.

## Do not build yet

- Contract-lock generator before the storage benchmark passes.
- Importer framework.
- Runtime migrations or repair-on-read.
- Epochs, mutable heads, schema catalogues, or bidirectional lenses.
- Matter table IDs without a live producer.
- History UI or generic snapshots.
