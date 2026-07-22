---
name: logging
description: 'wellcrafted/logger for library diagnostics: 5 levels, typed errors, injected sinks, and host-owned durability. Use for data/runtime factories, background errors, durable host logs, or replacing console.* in library code.'
metadata:
  author: epicenter
  version: '2.2'
---

# Workspace Logger

Structured, level-keyed, field-oriented logging for library code. Modeled on Rust's `tracing`. Completes the `defineErrors` story: errors are structured data; level lives at the call site.

Ground API and behavior claims in the official `wellcrafted-dev/wellcrafted`
source and logger declarations for Epicenter's installed version. Ground call
site examples in current Epicenter code.

## Where it lives

All of it ships from **`wellcrafted/logger`**: `createLogger`, `consoleSink`, `memorySink`, `composeSinks`, and the types. Runtime-agnostic, browser-safe. No file sink in-process: durability is a *host* concern (shell redirect, systemd journal, Cloudflare tail). The library emits to `consoleSink`; the operator decides where stdout/stderr go.

## Quickstart

```ts
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('markdown-materializer'); // defaults to consoleSink

log.info('materializer ready');

const result = await writeProjection();
if (result.error !== null) log.warn(result.error);
```

## The 5 levels

`trace | debug | info | warn | error`. No `fatal`: process termination is the app's call, not the library's.

| Level | Signature | Use for |
|---|---|---|
| `trace` | `(message, data?)` | Per-token / per-message noise; off in prod |
| `debug` | `(message, data?)` | Internal state transitions (handshakes, cache loads) |
| `info`  | `(message, data?)` | Lifecycle events (connected, loaded, flushed) |
| `warn`  | `(err)` | Recoverable failure: retry, fallback, partial result |
| `error` | `(err)` | Unrecoverable at this layer; the operation has given up |

**Shape split is intentional.** `warn` / `error` take a typed error unary: the variant carries `message`, `name`, and captured fields. `trace` / `debug` / `info` are free-form because free-running diagnostic events don't need enumeration.

Native `Error` also satisfies the logger's structural `{ name, message }`
contract. This is intentional for migration and exception boundaries; prefer a
tagged variant when the layer owns a stable failure vocabulary.

## Level is a call-site decision, not a variant property

```ts
// Right: same error, different levels in different contexts
log.warn(SyncError.ConnectionFailed({ cause }));  // inside retry loop
log.error(SyncError.ConnectionFailed({ cause })); // last attempt, giving up
```

Do NOT attach a `severity` to `defineErrors` variants. That's `miette`'s pattern; `tracing`, `log`, and every production Rust logger put level on the call. Context-dependent data belongs at the context.

## The dominant call-site shape

In epicenter, the typical pattern is **branch on the Result, log inside the branch, then take action**. The Result's data is usually needed on the Ok branch, so a chain combinator wouldn't earn its keep:

```ts
const walResult = trySync({
  try: () => db.query('PRAGMA journal_mode = WAL').get(),
  catch: (cause) => SqliteWriterError.PragmaSetupFailed({ pragma: 'WAL', cause }),
});
if (walResult.error !== null) {
  log.warn(walResult.error);
} else if (walResult.data !== 'wal') {
  log.warn(SqliteWriterError.WalSilentFallback({ actualMode: walResult.data }));
}
```

You can also mint-and-log a tagged variant directly inside a `.catch` tail when there's no Result to branch on:

```ts
}).catch((cause) => {
  log.warn(MaterializerWriteError.TableWriteFailed({ tableName, cause }));
});
```

## Sinks

A sink is `((event) => void) & Partial<AsyncDisposable>`: a callable with optional resource cleanup.

```ts
import {
  createLogger,
  consoleSink,    // default; routes to console[level]
  memorySink,     // for tests; returns { sink, events }
  composeSinks,   // fan out to multiple sinks
} from 'wellcrafted/logger';
```

### Durability is the host's job

For a long-running daemon or CLI that needs durable logs, the library still emits to `consoleSink`; the operator decides where the stream goes:

```bash
bun run start                          # dev: console
bun run start 2>> ~/.app/app.jsonl     # ad-hoc file capture
systemd-run --user bun run start       # journal (structured queries via journalctl)
```

This used to be `jsonlFileSink`; that primitive was removed because owning a file writer in-process bought complexity (backpressure, dispose semantics, error fallbacks) that shell redirection already solves.

### `composeSinks(...)`: fan out

```ts
const sink = composeSinks(consoleSink, myCustomSink);
const log = createLogger('source', sink);
```

`composeSinks` forwards disposal to members that implement it (via `sink[Symbol.asyncDispose]?.()`). `consoleSink` is a no-op on dispose; stateful sinks flush and close.

### `memorySink()`: for tests

```ts
const { sink, events } = memorySink();
const log = createLogger('test', sink);
log.warn(MyError.Thing({ cause: new Error('boom') }));
expect(events).toHaveLength(1);
expect(events[0]).toMatchObject({ level: 'warn', source: 'test' });
```

Do NOT assert on `console.*` output. Inject a `memorySink` and inspect the event array.

## DI, not globals

No module-level logger registry. No `setDefaultLogger()`. Each attach primitive takes an optional `log?: Logger` option and defaults to `createLogger(<source>)` (console sink). Caller wires sinks explicitly.

```ts
const markdown = attachMarkdownExport(workspace, { dir, tables, log });
const sqlite = attachBunSqliteMaterializer(workspace, { filePath, log });
const collaboration = openCollaboration(workspace.ydoc, {
	url,
	openWebSocket,
	onReconnectSignal,
	log,
});
```

Share one sink across loggers when you build a custom one:

```ts
const sink = composeSinks(consoleSink, myCustomSink);
const markdown = attachMarkdownExport(workspace, {
	dir,
	tables,
	log: createLogger('workspace/markdown', sink),
});
const sqlite = attachBunSqliteMaterializer(workspace, {
	filePath,
	log: createLogger('workspace/sqlite', sink),
});
```

## Browser

The whole surface is pure JS and browser-safe.

## Event shape

Every sink receives:

```ts
type LogEvent = {
  ts:      number;    // epoch millis
  level:   LogLevel;  // 'trace' | 'debug' | 'info' | 'warn' | 'error'
  source:  string;    // from createLogger()
  message: string;    // human text: for warn/error, inherited from the typed error
  data?:   unknown;   // the typed error for warn/error; free-form for info/debug/trace
};
```

Custom sinks that serialize for the wire should convert `ts` to ISO-8601 and flatten native `Error` instances (otherwise they JSON.stringify to `{}`).

## See also

- `error-handling` skill: the `trySync`/`tryAsync` patterns the logger consumes
- `define-errors` skill: how to mint the typed error variants the logger consumes
- `rust-errors` skill: full `tracing` ↔ `Logger` mapping
- `tapErr` (from `wellcrafted/result`): Result-chain combinator that logs on the Err branch and passes the Result through. Rare in epicenter, since most call sites branch on `result.error` directly to use the data on the Ok branch. Reach for it only when the Result flows out of the function in a `.then(...)` chain.
