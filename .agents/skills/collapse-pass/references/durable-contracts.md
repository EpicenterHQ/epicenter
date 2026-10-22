# Durable contracts

Identify the current contract owners before simplifying storage, sync, auth, or
public schemas. Exact names and layouts belong in their source and subsystem
READMEs. A copied inventory in a skill can turn superseded architecture into a
false constraint.

## Trace what must survive

Use these source owners as starting points, then trace their callers and tests:

- [Browser store addresses](../../../../packages/data/src/store/browser.ts):
  the IndexedDB names a device's stores live under. Changing their shape
  detaches existing local data from the code that should reopen it.
- [Document roots](../../../../packages/data/src/store/document.ts): the
  `tables:<name>` and `kv` roots of a database's one Yjs document. `Doc.get`
  mints a root on miss and a root cannot be removed, so renaming a table strands
  every row stored under the old name.
- [Server partition names](../../../../packages/server/src/principal.ts) and
  [the sync route](../../../../packages/sync/src/store-route.ts): trace durable
  authority names and how the server resolves whose data a request can reach.
  Preserve partitioning as well as wire compatibility; whose data a connection
  reaches comes from the resolved bearer, not from the URL.
- [Auth schemas](../../../../packages/auth/src/auth-types.ts) and
  [principal types](../../../../packages/principal/src/principal.ts): trace
  persisted values, wire schemas, and consumers before changing fields or brands.
- Applied migrations record stored-data history. Preserve them during routine
  cleanup; use the current schema and migration workflow for an authorized change.
  Change generated output through its source owner rather than hand-editing it.

A public export with no in-repo callers still needs an external-consumer check.
Inspect package exports, CLI entrypoints, examples, and known downstream usage.
An internal helper and an externally consumed contract have different deletion
costs, regardless of caller count.

Name the information a proposed change protects, how existing work remains
accessible, and which consumer contracts survive. Surface a durable-format or
consumer-contract change before editing; ask when it exceeds existing
authorization.

## Preserve the error contract

Keep `defineErrors` factory calls rather than replacing them with inline error
objects merely to remove a helper. The factory owns variant identity and message
templates. See [error variants](../../error-handling/references/error-variants.md)
and [logging](../../logging/SKILL.md).
