# Workspace contract clean break

**Date**: 2026-07-14
**Status**: In Progress
**Owner**: Epicenter workspace
**Branch**: `codex/records-epoch-clean-break`

## One Sentence

Epicenter gives each application contract version one forward-moving workspace
whose complete logical state can be exported as tables, key-value data,
documents, and external blobs, then changed only through validated forward
mutations.

## Starting State

The branch has the correct version-qualified namespace and server-ordered table
protocol, but the app API says `dataVersion`, table declarations split
`fields` from `documents`, blob identity lives in a workspace registry, and the
only portable artifact is a records-only logical snapshot.

```ts
defineWorkspace({
	appId: 'whispering',
	dataVersion: 2,
	tables: {
		recordings: defineTable({
			fields: { id: field.string(), title: field.string() },
			documents: { transcript: document.plainText },
		}),
	},
	blobs: { audio: 'whispering.audio/1' },
});
```

## Target Shape

```ts
defineWorkspace({
	appId: 'whispering',
	version: 2,
	tables: {
		recordings: defineTable({
			fields: {
				id: field.string<RecordingId>(),
				title: field.string(),
				audio: field.blob(),
				transcript: field.doc(document.plainText),
			},
		}),
	},
});
```

The portable folder is:

```text
workspace.json
tables.sqlite3
kv.json
documents/
blobs/
```

The durable decisions are [ADR-0137](../docs/adr/0137-applications-declare-one-live-workspace-per-contract-version.md),
[ADR-0138](../docs/adr/0138-tables-declare-cells-documents-and-blobs-in-one-field-map.md),
and [ADR-0139](../docs/adr/0139-portable-workspaces-are-schema-directed-folders-applied-as-forward-mutations.md).

## Implementation Plan

## Progress

- Wave 1 is implemented: the public contract and append-only tooling use
  `version` and `workspace-version-lock.json` with no compatibility reader.
- Wave 2 is implemented: one table `fields` map declares cells, documents, and
  BlobRefs; application blob deletion and the workspace blob registry are gone.
- Wave 3 export is implemented: complete export rebuilds `tables.sqlite3`,
  writes KV, encodes Yjs document state, verifies every blob, and publishes the
  folder atomically. Fresh-destination import still needs its proof.
- Wave 4 is implemented through the authority and CLI: edited SQLite is parsed
  against its sibling manifest, planned against latest live state, previewed,
  approved, and admitted as one expected-head transaction. End-to-end hosted
  verification remains before acceptance.

### Wave 1: Freeze the contract vocabulary

- Replace `dataVersion` with `version` in the public definition, lock format,
  lock tooling, fixtures, source layout checks, tests, and current docs.
- Rename `data-version.ts`, the lock file, constants, types, scripts, and package
  commands with no compatibility reader.
- Keep `recordsEpoch` narrow and unchanged.

Proof: lock parser tests, definition tests, lock history tests, example smoke
test, package typecheck, and repository hygiene checks pass with no public
`dataVersion` or data-version lock references outside superseded ADR history.

### Wave 2: Make the table declaration the manifest

- Export a composed `field` catalog from `@epicenter/workspace/sqlite`.
- Add `field.doc(format)` as a declaration-only field and migrate every SQLite
  table `documents` map into `fields`.
- Add `field.blob()` with a validated immutable `BlobRef` cell representation.
- Remove workspace blob-plane declarations and include document and blob field
  contracts in the workspace version lock.
- Keep the runtime document opener path `tables.<table>.docs.<field>.open(rowId)`.

Proof: type tests distinguish row cell values from document fields; descriptor
tests omit document fields but include blob reference schemas; document address
tests use the declared field name; lock tests reject drift in either declaration.

### Wave 3: Build the portable folder

- Define and validate `workspace.json` and its content manifest.
- Materialize a clean `tables.sqlite3` from the logical table snapshot instead
  of copying runtime storage.
- Export declared KV into `kv.json`, reachable documents into `documents/`, and
  referenced blob bytes into `blobs/`.
- Fail complete export when referenced bytes are unavailable. Name any partial
  export explicitly.

Proof: a fixture exports, opens its SQLite file in a separate process, verifies
all logical values and content hashes, imports into a fresh identity, and
produces the same logical export.

### Wave 4: Apply edited tables as forward intent

- Add a tables-only desired-state planner over current head and edited
  `tables.sqlite3`.
- Preview creates, updates, deletes, overwritten drift, document fallout, and
  blob fallout.
- Add one server-side bounded batch admission with expected-head compare and
  swap. Refuse oversized patches.
- Expose `epicenter tables apply` with mandatory confirmation unless an explicit
  noninteractive approval flag is supplied.

Proof: concurrency tests force a head move between plan and admission and prove
no partial mutation lands; end-to-end tests prove accepted state exactly equals
the edited tables file.

### Wave 5: Delete the old model

- Remove separate table `documents`, workspace `blobs`, data-version naming,
  records-only portability claims, and any obsolete recovery wording.
- Update `docs/CONTEXT.md`, `docs/architecture.md`, workspace reference docs,
  package README examples, and ADR index relationships.
- Accept ADRs 0137 through 0139 and delete this spec only after all proof passes.

## Invariants

- One principal, app ID, and version resolves one live workspace.
- Version is a durable contract ordinal, not a software release number.
- Blob bytes become durable before their reference is committed.
- Deleting a row never resurrects it and does not require synchronous physical
  deletion in another storage plane.
- Export contains logical application state, never replica identity or pending
  transport machinery.
- Restore never rewinds a live workspace under the same identity.
- Apply emits ordinary forward mutations and wins one expected-head compare and
  swap or changes nothing.

## Refusals

- No compatibility alias for `dataVersion` or the old lock format.
- No current-workspace pointer, workspace catalog, or server predecessor API.
- No automatic cross-version copy, merge, or migration graph.
- No permanent tombstone set or synchronous Yjs and blob deletion transaction.
- No first-class relocatable document IDs or application blob deletion API.
- No same-ID restore, rollback, client authority promotion, or three-way apply.
- No whole-folder atomic apply in the first implementation.

## Verification

Run the narrow package tests after each wave, then the repository gates:

```sh
bun test packages/workspace/src/sqlite
bun test scripts/check-workspace-version-locks.test.ts
bun run check:workspace-version-locks
bun run --filter @epicenter/workspace typecheck
bun run check:docs
bun run check:licenses
bun run typecheck
```

The clean-break grep must find no live code or current documentation using the
deleted public shapes. Superseded ADRs and git history are allowed to preserve
the old words.

## Settled Implementation Details

- Documents use complete Yjs V2 state updates in content-addressed `.yjs` files.
- Apply reuses the record protocol's one-mutation operation and byte ceilings.
- Apply previews complete created and deleted rows plus before and after values
  for every updated cell. A moved authority head produces a new preview.
- The initial exporter has no partial mode. Missing referenced content fails the
  export and leaves no destination.
