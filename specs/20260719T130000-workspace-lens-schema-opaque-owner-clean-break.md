# WorkspaceLens views over one schema-opaque owner: clean-break execution map

- **Status:** Draft
- **Date:** 2026-07-19
- **Decides:** [ADR-0156](../docs/adr/0156-a-workspace-opens-as-release-local-lens-views-over-one-schema-opaque-owner.md), [ADR-0157](../docs/adr/0157-workspace-sql-is-one-stable-schema-opaque-records-relation.md), [ADR-0158](../docs/adr/0158-trusted-apps-contribute-workspaces-through-one-built-inert-host-module.md)
- **Worktree note:** the dirty state on the user's main worktree is unrelated
  in-flight work and must not be touched by these waves. The
  `workspace-lens-docs` worktree that authored this spec contains only
  documentation (this spec, ADRs 0156 through 0158, and the ADR index rows);
  implementation waves start from a fresh worktree off `main`.

## One sentence

Epicenter stores and synchronizes schema-opaque workspaces by static ID; every
app and script brings a release-local `WorkspaceLens` made by
`defineWorkspace`, `runtime.open(lens)` returns a typed `Workspace` view over
one raw owner cached per workspace ID, lenses never cross the browser Worker,
desktop HTTP, sync, or server boundaries, nonconformance appears on row and KV
read (never at open), and `sql()` exposes one stable schema-opaque `records`
relation instead of per-lens TEMP views.

## Target API

```ts
import { defineTable, defineWorkspace } from '@epicenter/workspace/sqlite';
import { field } from '@epicenter/field';

// A WorkspaceLens: stable ID plus this release's interpretation. Inert.
export const honeycrispWorkspace = defineWorkspace({
	id: 'epicenter-honeycrisp',
	tables: {
		notes: defineTable({
			fields: { title: field.string(), pinned: field.boolean() },
			optional: ['pinned'],
		}),
	},
});

// Public open: one call, resolves with a ready typed view.
const workspace = await runtime.open(honeycrispWorkspace);
//    ^ type: Workspace<typeof honeycrispWorkspace>

// A second lens over the SAME ID coexists in the same runtime. No identity
// error; both views share one SQLite owner, one sync supervisor, one
// document runtime.
const archiveLens = defineWorkspace({
	id: 'epicenter-honeycrisp',
	tables: {
		notes: defineTable({
			fields: { title: field.string(), archivedAt: field.instant() },
			optional: ['archivedAt'],
		}),
	},
});
const archiveView = await runtime.open(archiveLens);

// Nonconformance is a read value, never an open failure.
const { data: note, error } = await workspace.tables.notes.get(id);
// error: RowLensError.NonconformingRow with the raw payload, or null.

// SQL: one schema-opaque relation, result schema validated app-side.
const rows = await workspace.sql(
	`SELECT row_id, json_extract(fields_json, '$.title') AS title
	 FROM records WHERE table_key = 'notes'`,
	[],
	Type.Object({ row_id: Type.String(), title: Type.String() }),
);
```

## Ownership diagram (target)

```txt
  app / script side (owns the lens)          owner side (schema-opaque)
+--------------------------------------+   +--------------------------------+
| WorkspaceLens (defineWorkspace)      |   | raw owner, cached by workspace |
|   id + table lenses + kv lens        |   | ID:                            |
|                                      |   |   SQLite storage (rows, kv    |
| Workspace view (runtime.open)        |   |     reserved row, documents)   |
|   create/update: validate -> intent  |   |   structural admission only    |
|   get/list/kv.get: project raw JSON  |   |     (row-sync bounds)          |
|   sql(): result-schema validation    |   |   sync supervisor + replica    |
|   document.open(rowId)               |   |   row-document runtime         |
|                                      |   |   records SQL relation         |
|  N lenses may bind to one owner      |   |   (table_key,row_id,           |
+-----------------+--------------------+   |    fields_json)                |
                  |                        +---------------+----------------+
                  |  IDs + schema-opaque operations only   |
                  +---------------------+------------------+
                                        |
        boundaries that carry NO lens, ever:
          browser: page <-> records Worker (postMessage protocol)
          desktop: WebView <-> Bun host (HTTP /api/workspaces/:id/records)
          sync:    replica <-> authority (WireRowIntent, current-state wire)
          server:  every hosted surface
```

## Current state: exact files, assertions, protocols

All paths relative to repo root. Line references are as of `main` at
`6d9b7fda06`.

### Names to rename (clean break, no aliases)

- `packages/workspace/src/sqlite/runtime-definition.ts`: `WorkspaceDefinition`
  type and the `defineWorkspace` return type. Becomes `WorkspaceLens`.
  `defineWorkspace` keeps its name (ADR-0130 vocabulary).
- `packages/workspace/src/sqlite/runtime.ts:115`: `WorkspaceHandle`. Becomes
  `Workspace`. Generic parameters `TDefinition` become `TLens` throughout the
  sqlite subpath.
- `packages/workspace/src/sqlite/index.ts`: barrel re-exports of both names.
- Consumers of the old names outside `packages/workspace/src` (rename blast
  radius, verified by grep):
  - `apps/honeycrisp/src/lib/workspace/index.ts` (`HoneycrispWorkspace = WorkspaceHandle<...>`), `apps/honeycrisp/src/lib/application.ts`
  - `apps/epicenter/src/workspace.ts` (`ConversationsWorkspace`)
  - `apps/whispering/src/lib/whispering/app.ts`, `recordings.ts`,
    `recipes.ts`, `recordings.test.ts`
  - `apps/skills/src/lib/application.ts`,
    `apps/skills/src/lib/state/skills-state.svelte.ts`
  - `packages/skills/src/workspace.ts`
- Naming collision to hold in mind, not fix here: the legacy root-Yjs runtime
  (`packages/workspace/src/document/workspace.ts:100,553`) already exports
  `Workspace` and `WorkspaceDefinition` types from the package ROOT barrel
  (`packages/workspace/src/index.ts`). The rename lands in the `/sqlite`
  subpath only. The legacy exports are ADR-0130 replacement targets and are
  deleted on their own schedule; until then the subpath disambiguates.

### One-lens-per-ID identity checks (deletion targets, ADR-0156)

- `packages/workspace/src/sqlite/runtime.ts:296` "already bound to another
  definition in this runtime" (`RuntimeEntry.definition !== definition`).
- `packages/workspace/src/sqlite/browser-runtime.ts:655` same message,
  page-side map.
- `packages/workspace/src/sqlite/browser-runtime-worker.ts:294-303` JSON
  comparison of serialized manifests; throws "already bound to another
  release-local lens in this Worker".
- `packages/workspace/src/sqlite/desktop-runtime.ts:299` same message,
  WebView-side map.
- `packages/workspace/src/sqlite/desktop-owner.ts:73` "is not registered with
  this definition" (registration by definition value identity).
- Test asserting the old behavior:
  `packages/workspace/src/sqlite/runtime.test.ts` "runtime binds one
  definition identity per workspace id". Replaced by a coexistence test (two
  lenses, one ID, one owner; each view projects per its own lens).

### Lens crossing boundaries today (violations to remove, ADR-0156)

- Browser Worker boundary:
  - `packages/workspace/src/sqlite/browser-runtime-protocol.ts:55-62`
    `BrowserWorkspaceManifest.tables` (`SerializedTableLens`) and `.kv`;
    `serializeTableLenses` at line 157.
  - `packages/workspace/src/sqlite/browser-runtime.ts:662-667` builds that
    manifest from `definition.tables` and `definition.kv`.
  - `packages/workspace/src/sqlite/browser-runtime-worker.ts:187-192` rebuilds
    lenses Worker-side with `defineTable`, then runs `createCanonicalRows`
    and `createCanonicalKv` (validation and projection execute in the
    Worker).
- Desktop HTTP boundary:
  - `packages/workspace/src/sqlite/desktop-owner.ts:36-49` Bun host holds a
    statically linked catalog of definition VALUES and dispatches typed
    `table.get/list/create/update` host-side (lens work in the host).
  - `apps/epicenter/src/workspace-owner.ts` imports `honeycrispWorkspace`,
    `skillsWorkspace`, `whisperingWorkspace`, `conversationsWorkspace` into
    the sidecar for exactly this purpose.
  - The wire itself (`desktop-protocol.ts` `DesktopRecordOperation`) is
    already schema-opaque; only the host-side interpretation moves.
- Sync wire: already conformant. `WireRowIntent` and the current-state
  protocol carry no lens. No change.
- Bun runtime (`bun-runtime.ts`): in-process over `createWorkspaceRuntime`;
  no boundary crossing. Only inherits the runtime.ts changes.

### Per-lens SQL machinery (replacement targets, ADR-0157)

- `packages/workspace/src/sqlite/canonical-rows.ts`:
  - `installTemporaryViews` (line 265): one TEMP view per declared table plus
    one `__epicenter_projection_<table>` TEMP table each.
  - `refreshTemporaryProjections` (line 290): re-copies every visible row of
    every declared table on EVERY `sql()` call.
  - `projectedSqlColumn` (line 310) and `sqlJsonTypes` (line 319): the
    CASE/json_type typed-column generator.
  - `assertSelectStatement` (line 356): keeps its SELECT-only, one-statement,
    and reserved-prefix rules; gains "only `records` is addressable".
- SQL callers today (all tests; there are no production callers):
  - `packages/workspace/src/sqlite/runtime.test.ts:303`
    (`SELECT id, title FROM notes`)
  - `apps/whispering/src/lib/workspace/greenfield-slice.test.ts:97,127`
    (`SELECT ... FROM recordings`, plus the rejected `DELETE`)
  - `apps/epicenter/src/desktop-workspace.test.ts:227` (rejected `UPDATE`)
  - `packages/skills/src/skills.test.ts:95` (`SELECT ... FROM skills`)
- Reserved-row exclusion input: `RESERVED_KV_TABLE = '__epicenter_kv'`
  (`packages/row-sync/src/admission.ts:32`); the `records` relation filters
  `table_key NOT LIKE '__epicenter%'`.

### Desktop host contribution (ADR-0158, held until 0156/0157 land)

- `apps/epicenter/src/workspace-owner.ts`: static definition imports become a
  static ID registration (`readonly string[]`), then later a union of bundled
  IDs plus catalog-derived `host.mjs` declarations.
- `apps/epicenter/src/local-source-catalog.ts`, `honeycrisp-catalog.ts`,
  `static-assets.ts`, `server.ts:440-448`: the catalog build and serve path
  that gains `src/epicenter.ts` compilation, `host.mjs` validation, and
  derived metadata. Exact file split decided at implementation time; the
  contract is ADR-0158's.

## Replacement waves

Each wave is: build the new path, stop importing the old path, verify, delete.
No wave leaves both paths imported.

### Wave 1: rename (mechanical, one commit)

Build/replace: rename `WorkspaceDefinition` to `WorkspaceLens` and
`WorkspaceHandle` to `Workspace` across the `/sqlite` subpath and the consumer
files listed above. No behavior change. No aliases.

Recognition: you are done when
`grep -rn "WorkspaceHandle\|WorkspaceDefinition" packages/*/src apps/*/src --include='*.ts' --include='*.svelte' | grep -v packages/workspace/src/document | grep -v daemon/mount-runtime`
returns nothing.

Proof:

```sh
bun run --filter '@epicenter/workspace' typecheck
bun run --filter '@epicenter/workspace' test
bun run typecheck
```

Delete: nothing beyond the old identifiers themselves.

### Wave 2: one records relation (ADR-0157)

Build: in `canonical-rows.ts`, replace per-lens view installation with one
`records` TEMP relation over visible current rows, excluding
`__epicenter%` table keys; extend `assertSelectStatement` so `records` is the
only addressable relation (runtime physical tables `rows`, `intents`,
`documents` become unreachable from `sql()`).

Stop importing old: rewrite the four SQL test call sites to
`table_key`/`json_extract` form; replace the typed-column expectations.

Verify: the three package proofs above, plus
`bun run --filter '@epicenter/epicenter' test` and
`bun run --filter '@epicenter/skills' test` and the whispering greenfield
slice test.

Delete: `installTemporaryViews`, `refreshTemporaryProjections`,
`projectedSqlColumn`, `sqlJsonTypes`, `projectionTableName`, and every
`__epicenter_projection_` string.

Recognition: `grep -rn "TEMP VIEW\|__epicenter_projection" packages/workspace/src`
returns nothing; a `SELECT * FROM notes` query rejects; the same data reads
through `records`.

### Wave 3: schema-opaque browser Worker (ADR-0156)

Build: move validation, projection, and row-ID minting to the page-side view
(the `createCanonicalRows`/`createCanonicalKv` lens halves relocate; the
Worker keeps storage, replica, supervisor, and structural admission). The
Worker protocol shrinks to raw operations: `read-current-row`, `list-rows`
(raw `(rowId, fields)` pairs), `admit-intent` (a `WireRowIntent`),
`kv-read-map`, `sql`, and the existing sync/capture/lifecycle operations.
`BrowserWorkspaceManifest` loses `tables` and `kv`.

Stop importing old: the page-side handle builds typed methods from the lens
and calls only raw operations; the Worker stops importing
`lens-definition.ts` entirely.

Verify: `browser-runtime.test.ts` (rewritten: typed ops still work
end-to-end; add the two-lens coexistence case; storage steal and held-storage
paths unchanged), package typecheck, repo typecheck.

Delete: `serializeTableLenses`, `SerializedTableLens`, the Worker
`defineTable` reconstruction (`browser-runtime-worker.ts:187-192`), the
manifest JSON comparison (lines 294-303), and the page-side identity check
(`browser-runtime.ts:655`); the `open` cache becomes owner-per-ID with
per-call lens views.

Recognition: `grep -rn "serializeTableLenses\|SerializedTableLens" packages`
returns nothing; `grep -rn "already bound" packages/workspace/src/sqlite`
returns nothing in browser files.

### Wave 4: schema-opaque desktop owner (ADR-0156)

Build: `createDesktopWorkspaceOwner` takes `workspaceIds: readonly string[]`
instead of definition values; `execute` dispatches raw operations against a
schema-opaque owner (structural admission only); the WebView
`desktop-runtime.ts` builds typed methods from the lens exactly as the
browser page side does, minting IDs and validating before `admit-intent`.
`runtime.ts` (`createWorkspaceRuntime`) splits into owner-per-ID cache plus
lens views so the Bun runtime and desktop owner share the same shape, and its
own identity check (line 296) is deleted.

Stop importing old: `apps/epicenter/src/workspace-owner.ts` stops importing
`honeycrispWorkspace`, `skillsWorkspace`, `whisperingWorkspace`,
`conversationsWorkspace` values for the owner (Bun-side code that READS a
workspace still imports its own lens and opens through the runtime like any
other surface).

Verify: `apps/epicenter/src/desktop-workspace.test.ts` (rewritten to open by
lens against the ID-registered owner; keep the cross-client invalidation and
document relay assertions), `host.test.ts`, `whispering-record-sync.test.ts`,
`bun run --filter '@epicenter/epicenter' test`, repo typecheck.

Delete: the owner's definition catalog and identity check
(`desktop-owner.ts:36-49,73`), the WebView identity check
(`desktop-runtime.ts:299`), the host-side typed-table dispatch in `execute`,
and the "binds one definition identity" runtime test (replaced in Wave 3's
coexistence coverage plus a runtime.ts equivalent).

Recognition: the sidecar bundle no longer links app schema code
(`grep -rn "honeycrispWorkspace\|whisperingWorkspace\|skillsWorkspace" apps/epicenter/src/workspace-owner.ts`
returns nothing); two WebView clients with different lenses drive one host
workspace in the desktop test.

### Wave 5: host contribution module (ADR-0158; gated on 0156/0157 landing)

Build: `src/epicenter.ts` convention, build-step compilation to inert
self-contained `host.mjs`, derived metadata, ID registration merge into the
Wave 4 owner, request-scoped action dispatch, trust-confirmation wording.

Stop importing old: nothing; this wave only adds the contribution path beside
the bundled ID registration.

Verify: one trivial local app declaring one workspace ID and one action,
built through the composition flow, appearing in the catalog, opening its
workspace by ID from its SPA, invoking its action; full restart activation;
uninstall leaves the workspace directory dormant.

Delete: nothing (first consumer). If Wave 5 stalls, ADR-0158 is superseded
rather than left half-built; Waves 1 through 4 do not depend on it.

## Proof commands (every wave)

```sh
bun run --filter '@epicenter/workspace' typecheck
bun run --filter '@epicenter/workspace' test
bun run typecheck
bun scripts/check-doc-hygiene.ts
```

Plus the per-wave app test filters named above.

## Explicit deletion-target summary

- `runtime.ts:296`, `browser-runtime.ts:655`, `desktop-runtime.ts:299`,
  `browser-runtime-worker.ts:294-303`, `desktop-owner.ts:73` identity checks.
- `browser-runtime-protocol.ts`: `SerializedTableLens`,
  `BrowserWorkspaceManifest.tables`, `BrowserWorkspaceManifest.kv`,
  `serializeTableLenses`.
- `browser-runtime-worker.ts`: `defineTable` reconstruction and its
  `lens-definition.ts` import.
- `canonical-rows.ts`: `installTemporaryViews`,
  `refreshTemporaryProjections`, `projectedSqlColumn`, `sqlJsonTypes`,
  `projectionTableName`.
- `desktop-owner.ts`: the `WorkspaceDefinition` catalog and host-side typed
  table dispatch.
- `apps/epicenter/src/workspace-owner.ts`: app schema value imports.
- `runtime.test.ts`: "runtime binds one definition identity per workspace
  id" (replaced by coexistence coverage).
- The identifiers `WorkspaceDefinition` and `WorkspaceHandle` in the sqlite
  subpath and all consumers.

## Out of scope

- The legacy root-Yjs runtime (`src/document/`, `daemon/mount-runtime.ts`)
  and its same-named exports: separate replacement track under ADR-0130.
- Any change to sync wire formats, ownership export, or the portable logical
  snapshot (ADR-0122 unchanged there).
- Third-party prebuilt app distribution (ADR-0153 defers it; ADR-0158 does
  not touch it).
