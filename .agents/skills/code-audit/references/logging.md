# Migrate library diagnostics to wellcrafted/logger

Hunt for library diagnostics emitted through direct console calls,
custom logging wrappers, or direct sink calls. Move them through
`wellcrafted/logger` while preserving useful information and behavior.

Use [the logging skill](../../logging/SKILL.md) for implementation rules,
including error ownership, levels, and sink selection.

## Search the audited scope

Start with the library package or directory under review:

```bash
audit_scope=packages/server/src
```

Find direct console access:

```bash
rg -n '\bconsole\s*(\.|\[)' \
  "$audit_scope" --glob '*.ts' --glob '*.svelte' --glob '!*.d.ts'
```

Find sink references, logger construction, and possible custom wrappers:

```bash
rg -n '\bconsoleSink\b|\bcreateLogger\b|\bLogger\b|\b(log|logger|report)\s*=' \
  "$audit_scope" --glob '*.ts' --glob '*.svelte' --glob '!*.d.ts'
```

Follow a suspected wrapper's imports and callers. Search for its actual
name when it differs from those above.

These searches produce candidates. Imports, comments, tests, ordinary
variables named `log`, and legitimate sink composition will appear.
Aliases and indirect helpers can escape the patterns.

No matches is a valid result. `rg` exits with status 1 when it finds none.

## Identify what should migrate

Trace the output from its call site to its destination.

Library diagnostics should use the shared logger. Distinguish them from
deliberate command output, application presentation, and sink
implementations before proposing a replacement.

For a custom wrapper, inspect all arguments and the resulting event.
Establish whether it preserves the original error and context or
silently drops information.

Code already using the shared logger has completed this migration.
Further changes to diagnostic names or fields belong to the logging
skill when that work is needed.

## Carry the migration through

Use the logging skill to choose the logger, source, level, and error
representation. Preserve the original cause and useful context.

Follow the affected callers. Remove the old wrapper once its diagnostic
callers have moved and it has no remaining responsibility.

Preserve failure handling and output contracts. Logging a failure must
not accidentally change whether the operation returns, retries, throws,
or continues.

When callers need different routing, provide access to the logger or
sink through the appropriate boundary rather than inventing another
logging interface.

## Historical example: server room diagnostics

Commit `f15bd2584f`, dated May 24, 2026, migrated diagnostics in
`packages/server/src/room/core.ts`.

The module added:

```ts
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('server/room/core');
```

A malformed-message branch changed:

```diff
 if (error) {
-  console.error(error.message);
+  log.warn(error);
   return;
 }
```

The error already carried a name and cause. Printing only its message
left that information out of the diagnostic. Passing the error through
the logger preserved it.

The branch still returned after rejecting that message. The migration
also deliberately classified that event as a warning.

The same commit changed a compaction announcement:

```diff
-console.log(`[compaction] ${count} entries to ${compacted.byteLength} bytes`);
+log.info('update log compacted', {
+  entries: count,
+  compactedBytes: compacted.byteLength,
+});
```

The announcement retained its measurements as fields, and both
diagnostics acquired the module's source.

Inspect the migration with:

```bash
git show f15bd2584f -- packages/server/src/room/core.ts
```

The room implementation has since been removed. This example records
a completed migration, not a current cleanup target.

## Current example of the destination

The [CLI's action runner](../../../../packages/cli/src/run.ts)
uses `createLogger`, accepts a caller-supplied logger through its `log`
option, and writes one record for each run through that interface.

Its [tests](../../../../packages/cli/src/run.test.ts)
supply a logger backed by `memorySink`, allowing emitted events to be
inspected without intercepting global console output.

## Verify and report

Where verification is needed, exercise the affected operation with a
memory sink. Check that the original failure and useful fields arrive,
and that surrounding behavior survives.

Report which diagnostics moved, what information was preserved or
recovered, and which redundant logging machinery disappeared.

Stop when remaining matches are deliberate output, sink implementation,
test support, or diagnostics already using the shared logger.
