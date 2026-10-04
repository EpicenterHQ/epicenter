# Epicenter database clean break

- **Status:** In Progress
- **Date:** 2026-07-20
- **Branch:** `codex/sqlite-sync-architecture`
- **Decision owners:** [ADR-0160](../docs/adr/0160-epicenter-opens-named-database-definitions.md), [ADR-0161](../docs/adr/0161-local-database-files-carry-their-logical-identity.md), [ADR-0162](../docs/adr/0162-database-definitions-install-connection-local-sql-views.md), [ADR-0163](../docs/adr/0163-scalar-synchronization-uses-one-database-sync-endpoint.md)

## One sentence

Replace the workspace-era package and vocabulary with one `Epicenter` owner
that opens named database definitions, persists one visible row relation,
derives read-only SQL views, and synchronizes scalar state through one endpoint.

## Boundary

This is a clean break. There are no aliases, deprecated exports, redirects,
dual writers, legacy readers, or migrations from the old root-Yjs stores.
First-party consumers either migrate in this branch or are removed from the
build graph. OpenCity and Tab Manager data migration is explicitly later work;
their old data is not rewritten by this change.

The current worktree contains unrelated user edits in:

```txt
apps/epicenter/src-tauri/tauri.dev.conf.json
apps/epicenter/src/ui/App.svelte
apps/epicenter/src/ui/runtime.ts
apps/whispering/src/routes/(app)/+page.svelte
apps/whispering/src/routes/(app)/_components/first-run-prototype/
tmp/
```

Implementation must not overwrite or absorb those edits.

## Public destination

```ts
const recordings = defineTable({
	fields: {
		createdAt: field.datetime(),
		transcript: field.string(),
	},
	document: true,
});

export const whisperingDefinition = defineDatabase({
	id: 'whispering',
	tables: { recordings },
	kv: {
		language: field.string(),
	},
});

await using epicenter = createDeviceEpicenter(options);
await using whispering = await epicenter.open(whisperingDefinition);

const row = await whispering.tables.recordings.get(rowId);
const result = await whispering.sql(
	'SELECT id, transcript FROM recordings ORDER BY createdAt DESC',
);
```

The root package exports only the coherent database API. Environment factories
live at explicit subpaths. Legacy workspace utilities that remain independently
valuable move to their real owner package; they do not hitchhike into
`@epicenter/database`.

## Target ownership

```txt
packages/database/
  src/
    definition.ts          defineDatabase, defineTable, definition types
    epicenter.ts           shared Epicenter owner contract
    database.ts            opened typed Database view
    table.ts               typed row operations
    kv.ts                  declared KV lens
    row-owner.ts           schema-opaque scalar owner composition
    document.ts            opt-in row document handle composition
    sql.ts                 view derivation, guarded reads, native reader, snapshot
    browser/
      index.ts             browser Epicenter factory
      worker.ts            OPFS owner and protocol
    bun/
      index.ts             Bun Epicenter factory and native reader
    desktop/
      index.ts             webview client
      owner.ts             trusted host owner and protocol
    index.ts               public root exports

packages/row-sync/         scalar protocol, folding, admission
packages/sqlite/           runtime-neutral SQLite adapters
packages/server/           account authority and transport, never database API
```

Files may split when they contain two independently changing concepts. Do not
create `client/`, `owner/`, `transport/`, or `projection/` folder layers merely
to mirror architecture diagrams. The public root must not expose internal
carrier DTOs, raw stores, SQLite connections, or protocol codecs.

## Storage destination

Local files contain one database and make `databaseId` implicit in row primary
keys. Account authority files contain many databases and keep `database_id` as
an explicit key component. Local private relations use the reserved prefix:

```txt
__epicenter_meta             one logical database identity
__epicenter_rows             current visible scalar rows
__epicenter_confirmed_rows   synchronized confirmed state, when needed
__epicenter_row_intents      synchronized pending rounds, when needed
__epicenter_replica          replica identity and checkpoint, when needed
__epicenter_document_*       opt-in row document update log
```

Exact supporting tables are earned by the existing replica invariants. Do not
add a parallel SQL fold. Every state transition that changes visible scalar
state updates `__epicenter_rows` in the same transaction.

`__epicenter_meta` stores the string database ID only. `user_version` owns the
physical version. `__epicenter_kv` remains the reserved logical row address for
KV rather than becoming a physical table.

## SQL destination

`sql()` never refreshes or copies rows. A definition deterministically derives
its views from table keys, field keys, and field base kinds. Same-realm owners
install those views directly. Browser and desktop carriers send the smallest
JSON-only `SqlViewDefinition` values; the owner revalidates identifiers and
finite kinds, then generates DDL. No path, schema, validator, hash, or DDL
crosses the boundary.

TEMP views are connection-owned runtime state. Installation happens before a
query can prepare. Reopening reconstructs them. Generic tools consume an inert
exported snapshot with persistent views; `openDatabaseReader` is the native
live-file API and verifies file identity first.

## Clean-break waves

### Wave 0: freeze decisions and prove the seams

- [ ] Add the four Proposed ADRs and this spec.
- [ ] Add focused tests for TEMP view replacement, prepared-query behavior,
  `query_only`, metadata mismatch, and cross-definition opens.
- [ ] Inventory every `@epicenter/workspace` import, workspace/record route, and
  production `record` noun before moving code.

### Wave 1: create the destination package

- [ ] Create `@epicenter/database` with `defineDatabase`, `defineTable`,
  `Epicenter`, `Database`, table, KV, SQL, and environment entrypoints.
- [ ] Move only SQLite row runtime code and its earned shared primitives.
- [ ] Implement `document: true`; tables without it expose no document surface.
- [ ] Keep definitions in the application realm and raw ownership by database
  ID.

### Wave 2: make current rows the one SQL read relation

- [ ] Introduce identity metadata and reserved physical names.
- [ ] Maintain `__epicenter_rows` transactionally for local writes, optimistic
  intents, push acknowledgement, pull, acquisition, install, and recovery.
- [ ] Delete the per-query TEMP `records` table and refresh loop.
- [ ] Install definition-derived TEMP views through validated internal
  `SqlViewDefinition` values.
- [ ] Add `openDatabaseReader` and inert SQLite snapshot export.

### Wave 3: collapse the scalar transport

- [ ] Rename protocol and authority context from workspace/record to
  database/row without changing convergence semantics.
- [ ] Replace three records routes with
  `POST /api/databases/:databaseId/sync` and one union parser/dispatcher.
- [ ] Keep push first-contact admission and row-document WebSockets independent.

### Wave 4: migrate owners and applications

- [ ] Migrate server, browser Worker, Bun, and desktop owners to database
  vocabulary and package imports.
- [ ] Migrate first-party applications required by the root build.
- [ ] Move independently useful legacy utilities to truthful owner packages or
  delete them with their callers.
- [ ] Deliberately remove deferred OpenCity or Tab Manager consumers from the
  build graph if migrating them would preserve the obsolete API.

### Wave 5: delete the old world

- [ ] Delete `packages/workspace` and every `@epicenter/workspace` dependency,
  export, tsconfig reference, script, and documentation claim.
- [ ] Remove `/workspaces`, `/records`, `Workspace*`, `Record*`,
  `__epicenter_records*`, and bare SQL `records` production vocabulary from the
  destination surfaces.
- [ ] Update `docs/CONTEXT.md`, package READMEs, examples, and relevant accepted
  ADR amendments so row and database are current truth.

### Wave 6: accept and erase scaffolding

- [ ] Run the verification matrix and post-implementation review.
- [ ] Resolve every Proposed decision against the implementation, then mark the
  ADRs Accepted and update their index rows.
- [ ] Delete this completed spec. Git keeps its execution history.

## Verification

```sh
bun run typecheck
bun run test
bun run check:licenses
bun scripts/check-doc-hygiene.ts
```

Focused checks must cover `@epicenter/database`, `@epicenter/row-sync`,
`@epicenter/sqlite`, `@epicenter/server`, Epicenter desktop, Whispering, and any
other migrated application. Run package-local suites first, then the root
commands.

The stale-symbol audit must return no unexplained production matches:

```sh
rg -n "@epicenter/workspace|defineWorkspace|Workspace(Lens|Definition|Handle)?|/workspaces|/records|__epicenter_records|\brecords?\b" \
  packages apps docs --glob '!docs/adr/**'
```

Allowed matches must be either unrelated domain language with an explicit
reason or historical ADR text. Tests and comments are not exemptions when they
describe the new contract.

## Completion condition

The work is complete only when the repository builds and tests without
`packages/workspace`, the public API reads naturally in at least two real
applications, SQL reads the durable visible relation without copying rows, the
single sync endpoint passes conformance tests, native readers reject the wrong
database identity, and the completed spec is deleted after its ADRs become
Accepted.

