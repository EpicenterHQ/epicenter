# Durable contracts

Identify the system being changed and its current contract owners before
simplifying storage, sync, auth, or public schemas. Start with its README,
exports, callers, and tests. For local Epicenter apps, follow
[@epicenter/app](../../../../packages/app/README.md) and
[the CLI](../../../../packages/cli/README.md); hosted services have their
own contract owners.

Exact names and layouts belong in source and subsystem READMEs. A copied
inventory in a skill can turn an earlier architecture into a false constraint.

## Source owners to inspect

Use the current subsystem's owner rather than apply one folder model to every
app. These paths are starting points to verify against exports and callers:

- Local apps: [app contracts](../../../../packages/app/README.md) and
  [CLI commands and storage](../../../../packages/cli/README.md).
- Hosted API access: [server routes](../../../../packages/server/src/routes).
  Trace durable authority names and how a request resolves whose data it may
  reach.
- Account identity: [auth schemas](../../../../packages/account/src/auth-types.ts)
  and [principal types](../../../../packages/account/src/principal.ts). Trace
  persisted values, wire schemas, and consumers before changing fields or brands.

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

Files are the durable record in a file-backed app. Renaming a contract path or
record stem can detach existing files even when the new code still writes
successfully. Follow both the old and new addresses before concluding that
stored work remains accessible.

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
