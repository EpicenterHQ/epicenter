---
name: workspace-api
description: 'Epicenter workspace API patterns: `defineWorkspace`, `defineTable`, `defineKv`, table `.docs(...)`, migrations, actions, `connect(...)`, materializers, and lower-level `createWorkspace` / `openCollaboration` primitives. Use when editing workspace schemas, table/KV access, row child docs, actions, runtime connections, app-owned projections, or collaboration setup.'
metadata:
  author: epicenter
  version: '8.0'
---

# Workspace API

Epicenter workspace definitions, table and KV access, isomorphic action registries, row child docs, runtime connection, app-owned composition, and lower-level Y.Doc primitives share one model.

Notebook model:

```txt
defineWorkspace = pure app contract: id, name, tables, kv, actions, child-doc declarations
connect(...)    = browser/local runtime: storage, optional relay sync, child-doc openers, wipe
createWorkspace = low-level root Y.Doc bundle for internals, tests, and older ports
table.docs(...) = row child-doc declaration; callers open through tables.X.docs.field.open(rowId)
```

## Reference Repositories

- [Yjs](https://github.com/yjs/yjs): CRDT framework used by the workspace data layer
- [Yjs Protocols](https://github.com/yjs/y-protocols): sync, awareness, and protocol helpers used around collaboration

## Upstream Grounding

When workspace behavior depends on Yjs transactions, shared types, update encoding, document lifecycle, or conflict semantics, use source-backed grounding before relying on memory. If DeepWiki MCP is available, ask a narrow question against `yjs/yjs`; for collaboration sync or awareness protocol behavior, ask against `yjs/y-protocols`. If DeepWiki is unavailable or the repo is not indexed, use upstream source or official docs directly. Treat DeepWiki as orientation, then verify decisive details against local workspace code, installed types, tests, or official docs before changing code.

Skip DeepWiki for Epicenter schema, action, migration, and attachment conventions already documented below.

## Related Skills

- `yjs`: Yjs CRDT patterns and shared types
- `svelte`: reactive wrappers such as `fromTable` and `fromKv`, plus commit-on-blur workspace inputs
- `attach-primitive`: the full contract and invariants every `attach*` function must follow
- `typebox`: TypeBox primitives used by `field.*`, `defineKv`, and action input schemas

## Core Rules

- Workspace action `defineQuery` / `defineMutation` factories are not Whispering `$lib/rpc` adapters from `wellcrafted/query`. Do not apply workspace action input-schema rules to Whispering RPC modules.
- `_v` is library-managed. Never declare it as a column, never set it on a write, never read it off a row. Single-version tables drop the versioning surface entirely; multi-version tables expose it only inside the `migrate` function as `({ value, version })`.
- Columns are TypeBox schemas. Prefer the `field.*` builders from `@epicenter/field` (`field.string`, `field.number`, `field.boolean`, `field.select`, `field.json`, `field.datetime`) plus the standalone `nullable` wrapper from `@epicenter/workspace` for the emptiness axis (an IANA timezone is just `field.string<IanaTimeZone>()`, no bespoke builder); raw `Type.X()` is allowed and the `FlatJsonTSchema` constraint enforces SQLite-mappable shapes either way.
- Derive row types with `InferTableRow<typeof tableDefinition>` in the same module that defines the table. Consumers import the type from the workspace definition module.
- Do not re-derive row types from runtime table methods or relay them through state files.
- KV stores use `defineKv(schema, defaultValue)` where `defaultValue` is a **factory** `() => Static<S>`. Prefer one scalar per dot-namespaced key unless the value is a true atomic object.
- Every table `id` and string foreign key uses a branded type plus a co-located generator. The brand lives as a pure type alias (`type X = string & Brand<'X'>`); the generator uses `generateId<X>()`. Call sites use the generator, never a direct cast.
- Export an app's shared model as `defineWorkspace({ id, name, tables, kv, actions })`. The workspace file is the sync contract: schema, branded IDs, KV defaults, isomorphic actions, and `table.docs(...)` child-doc layouts.
- Put isomorphic actions in the `actions: ({ tables, kv, ydoc }) => defineActions({ ... })` callback. Runtime-specific actions live in `connect(..., compose)` or an explicit application opener where browser, Node, Tauri, extension, or materializer APIs are in scope.
- Use `workspaceDefinition.connect(null)` for local-only browser storage and `workspaceDefinition.connect(connection)` for principal-scoped storage plus relay sync. Connected tables expose row child-doc openers at `tables.X.docs.field.open(rowId)`.
- There is no workspace mount or generic daemon composition API. An application that needs local execution owns its opener and explicit `sync`, `status`, or foreground `watch` commands.
- Treat `createWorkspace({ id, tables, kv })` as the lower-level root constructor for internals, tests, and older ports. It exposes `{ ydoc, tables, kv, actions, [Symbol.dispose] }`; app-facing code normally starts from `defineWorkspace`.
- Do not import or compute child-doc guids with `docGuid`. The public contract is `tables.X.docs.field.guid(rowId)` and `tables.X.docs.field.open(rowId)`.
- Local action calls see the handler shape directly. Adapter calls use
  `invokeAction`, which validates input, wraps raw values in `Ok`, preserves
  existing `Result`s, and catches throws as `Err(cause)`. Read the action return
  reference before changing handler failure behavior.
- Every action method inside the workspace action object should have JSDoc that adds developer-facing value beyond the short `description` field.
- Keep workspace schema and isomorphic actions runtime-neutral. If an action file is extracted, it must stay isomorphic too. Keep runtime singletons and auth subscriptions in `client.ts`, `browser.ts`, `tauri.ts`, or app-specific openers.
- Compose lower-level attachments inline when you are below `defineWorkspace.connect(...)`. Avoid wrapper helpers that hide ordering unless the abstraction owns a real invariant.
- For one-off scripts, prefer application SQLite, exported files, or an explicit app command. Do not reintroduce a local `connectWorkspace()` shortcut or generic process manager.

## Reference Map

- [Schema definition patterns](references/schema-definition-patterns.md): `defineTable`, `defineKv`, row type inference, KV scalar design, and branded IDs.
- [Actions, layout, and attachments](references/actions-layout-and-attachments.md): `defineWorkspace` actions, JSDoc, runtime action composition, file layout, attachment ordering, and application command boundaries.
- [Deriving action input schemas](references/deriving-action-inputs.md): use `tables.X.schema` and `schema.properties.X` to compose `defineQuery`/`defineMutation` input schemas inline. No helper layer.
- [Action return shapes](references/action-return-shapes.md): direct calls vs adapter `invokeAction` return contracts and error normalization.
- [Table, KV, CRUD, and observation](references/table-kv-crud-observation.md): table/KV read, write, observe, and derived-state details.
- [Table migrations](references/table-migrations.md): migration rules and version evolution examples.
- [Primitive API](references/primitive-api.md): lower-level primitive contracts and composition details.
