# Scripting

Scripts use an application's explicit data or command surface. There is no
Epicenter root, mount discovery, resident watcher, or generic action protocol.

## Read local SQLite directly

External-source products such as Local Mail and Local Books own disposable
SQLite mirrors. Read those files directly when a script only needs facts:

```ts
import { openSqliteReader } from '@epicenter/workspace/node';

using mirror = openSqliteReader({
	filePath: '/absolute/path/to/books.db',
});

const stale = mirror.db
	.query('SELECT id FROM invoices WHERE deleted = 0 AND updated_at < ?')
	.all('2026-01-01T00:00:00Z');
```

The path belongs to the application, not to a shared `.epicenter/` convention.
Use the app's `status` output or configuration to find it. The reader opens
SQLite read-only, so an accidental write fails instead of diverging from the
upstream system.

## Refresh and monitor

Applications that need command-line catch-up expose the same operator model:

```text
<app> sync     refresh once, then exit
<app> status   report durable freshness, cursor, and upstream health
<app> watch    refresh in the foreground until Ctrl-C
```

Use `launchd`, cron, systemd, or another scheduler to run `sync` periodically.
A service manager may supervise `watch`; it owns restart, shutdown, and log
capture. Epicenter does not add a second process manager around it.

## Writes

Write through the source of truth. Local Mail mutates Gmail first. Local Books
mutates QuickBooks first. Workspace-backed apps expose product-specific actions
or commands that open their own runtime and use the app's forward APIs.

Do not add a generic `run <action>` command, peer address, or workspace mount to
make one script possible. Name the workflow and put it beside the application
that owns its invariants, validation, approval, and retry behavior.

## Markdown and portable tables

Markdown exports are read-only projections unless an application explicitly
declares Markdown as its source of truth. Scripts may scan, publish, archive, or
lint them like normal files.

Portable `tables.sqlite3` edits use `epicenter tables apply`. That command
previews forward mutations against a locked workspace definition; it does not
open a resident runtime.
