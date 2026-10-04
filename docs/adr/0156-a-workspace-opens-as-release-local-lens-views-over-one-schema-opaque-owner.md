# 0156. A workspace opens as release-local lens views over one schema-opaque owner

- **Status:** Proposed
- **Date:** 2026-07-19
- **Amends:** [ADR-0130](0130-workspace-definitions-expose-tables-with-row-owned-documents-and-a-release-local-kv-lens.md) at the public vocabulary and open-identity boundary; the tables-plus-kv shape, row mutation vocabulary, and document capability stand unchanged.
- **Relates:** [ADR-0122](0122-logical-records-are-portable-sqlite-files-and-views-are-runtime-state.md), [ADR-0125](0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md), [ADR-0135](0135-row-documents-have-application-owned-roots.md), [ADR-0140](0140-open-workspaces-synchronize-automatically-and-callers-settle-one-watermark.md), [ADR-0143](0143-account-open-never-consumes-device-data.md), [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md)

## Context

ADR-0125 made record definitions release-local lenses over one schema-opaque
canonical record map, but the runtime still treats one lens value as the
workspace's identity at open. `createWorkspaceRuntime`, the browser runtime,
its records Worker, the desktop WebView runtime, and the desktop Bun owner all
reject a second `open` for the same workspace ID unless it presents the same
definition value (or, in the Worker, a byte-identical serialized copy). The
browser runtime serializes table and KV lenses into the Worker manifest and
rebuilds them there, and the desktop Bun owner holds a statically linked
catalog of definition values, so a release-local interpretation crosses process
boundaries and becomes shared state. The names `WorkspaceDefinition` and
`WorkspaceHandle` reinforce the wrong reading: that the value defines the
workspace rather than one release's view of it.

## Decision

Epicenter stores and synchronizes schema-opaque workspaces addressed by static
workspace ID. Every app and script brings its own release-local
`WorkspaceLens` value made by `defineWorkspace`, and the public open is:

```ts
const workspace = await runtime.open(honeycrispWorkspace);
```

`WorkspaceDefinition` is renamed to `WorkspaceLens` and `WorkspaceHandle` to
`Workspace` as a clean break: no aliases, no deprecation re-exports. A
`WorkspaceLens` carries the stable workspace ID it addresses plus this
release's table and KV lenses; `Workspace` is the typed view `open` returns.

Each runtime caches one raw owner per workspace ID: the SQLite storage, the
sync supervisor, and the row-document runtime. `open` binds a lens view to
that cached owner. Multiple typed views with different lenses over the same ID
may coexist in one runtime; the one-definition-per-ID identity checks are
deleted, not relaxed.

Lenses are app-side JavaScript values and never cross a boundary. The browser
Worker, the desktop HTTP protocol, the sync wire, and every server surface
carry only workspace IDs and schema-opaque operations: rows as
`(table_key, row_id, fields JSON)`, `WireRowIntent` values, raw KV JSON, and
document updates. Validation and projection execute in the surface that owns
the lens: `create` and `update` validate before submitting an intent; `get`,
`list`, and `kv.get` project after retrieval. Owners keep only schema-opaque
structural admission (portable row-sync bounds); they hold no lens copy and
re-validate nothing.

Nonconformance is a read-side value (`RowLensError`, `KvReadError`), never an
open failure. `open` rejects only for storage and environment acquisition
reasons (held storage, disposed runtime, transport handshake). Workspace IDs
are static literals; there is no dynamic ID minting, per-lens identity,
fingerprint, or lens-equality negotiation between surfaces.

## Consequences

- The "already bound to another definition" errors in `runtime.ts`,
  `browser-runtime.ts`, `desktop-runtime.ts`, the Worker's serialized-manifest
  comparison, and the desktop owner's registration identity check are deleted.
- The Worker manifest loses its `tables` and `kv` fields;
  `serializeTableLenses` and the Worker-side `defineTable` reconstruction are
  deleted. The desktop Bun owner's catalog shrinks from definition values to a
  registration of workspace IDs.
- Two views with different lenses read the same bytes differently. That is
  ADR-0125's existing doctrine made concurrent instead of sequential; patch
  semantics already prevent them from erasing each other's keys.
- The write boundary is raw: a buggy or dishonest app-side writer can submit
  values invalid under another lens, and the owner admits them if they satisfy
  structural bounds. Per ADR-0125 this is retained honest data, not
  corruption; the same-origin trust model (ADR-0118, ADR-0153) is the
  protection, exactly as it is for typed table methods today.
- Renames are mechanical and small (roughly ten consumer files outside
  `packages/workspace`). The legacy root-Yjs runtime still exports `Workspace`
  and `WorkspaceDefinition` types from the package root barrel; the SQLite
  subpath owns the new names, and the legacy exports remain a deletion target
  under ADR-0130's replacement doctrine, not a naming constraint.
- Per-lens SQL views cannot survive multi-lens coexistence on one connection;
  the SQL read surface is decided separately in ADR-0157.

## Considered alternatives

- **Keep the `WorkspaceDefinition` and `WorkspaceHandle` names.** Rejected
  because "definition" claims ownership of workspace identity that ADR-0125
  already removed; the value is a lens and the name should say so.
- **Ship compatibility aliases during migration.** Rejected; pre-user clean
  break per ADR-0130's replacement doctrine. Aliases would let old imports
  compile and hide unfinished waves.
- **Key the owner cache by (ID, lens) pairs.** Rejected because it would open
  one SQLite storage twice, violating the single-owner storage invariant the
  lease and `ownedRoots` guards exist to enforce.
- **Negotiate lens equality across surfaces.** Rejected because equality
  hashes recreate the schema-identity and release-fencing machinery ADR-0125
  deleted.
- **Split the call into `open(id, lens)`.** Rejected because the lens is
  meaningless without the ID it interprets and no caller supplies them
  independently; one imported value is the honest unit.
