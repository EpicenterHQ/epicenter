# Durable contracts

Identify the system being changed and its current contract owners before
simplifying storage, sync, auth, or public schemas. Start with its README,
exports, callers, and tests. For local Epicenter apps, follow
[@epicenter/app](../../../../packages/app/README.md) and
[the CLI](../../../../packages/cli/README.md); the synced-folder packages and
hosted services have their own contract owners.

Exact names and layouts belong in source and subsystem READMEs. A copied
inventory in a skill can turn an earlier architecture into a false constraint.

## Trace what must survive

Trace the stored paths, identities, serialized shapes, commands, tool names,
and answer formats that actual consumers depend on. Include text later commands
parse, such as history records, and paths that must remain private to one
computer. Use the relevant contracts rather than treating every storage system
as the same folder model.

Renaming a stored path, record stem, or identity can detach existing work even
when new writes succeed. Follow how requests resolve whose data they can reach;
preserve partitioning as well as wire compatibility. A new layout does not grant
permission to delete the old records.

Applied migrations record stored-data history. Preserve them during routine
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
