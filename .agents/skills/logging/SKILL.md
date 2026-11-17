---
name: logging
description: 'wellcrafted/logger for library diagnostics: 5 levels, typed errors, injected sinks, and host-owned durability. Use for library diagnostics, background errors, durable host logs, or replacing console.* in library code.'
metadata:
  author: epicenter
  version: '2.2'
---

# Library logging

Structured, level-keyed, field-oriented logging for library code. Modeled on Rust's `tracing`. Completes the `defineErrors` story: errors are structured data; level lives at the call site.

Ground API and behavior claims in the official `wellcrafted-dev/wellcrafted`
source and logger declarations for Epicenter's installed version. Ground call
site examples in current Epicenter code.

## Where it lives

All of it ships from **`wellcrafted/logger`**: `createLogger`, `consoleSink`, `memorySink`, `composeSinks`, and the types. Runtime-agnostic, browser-safe. No file sink in-process: durability is a *host* concern (shell redirect, systemd journal, Cloudflare tail). The library emits to `consoleSink`; the operator decides where stdout/stderr go.

## Quickstart

The [browser OAuth client](../../../packages/account/src/browser-oauth.ts) defaults its `log` parameter to `createLogger('auth/browser-oauth')`. A listener can fail after the client has changed state. Log the failure and continue notifying the remaining listeners.

```ts
try {
	listener();
} catch (cause) {
	log.error(BrowserOAuthDiagnostic.ListenerFailed({ cause }));
}
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

The [billing client](../../../apps/api/worker/billing/autumn.ts) logs a rejected provider request at `error` when the provider reports a client-side failure. A transient provider or transport failure goes to `warn`. Both paths return `BillingError.ProviderRequestFailed()` to the caller.

Do NOT attach a `severity` to `defineErrors` variants. That's `miette`'s pattern; `tracing`, `log`, and every production Rust logger put level on the call. Context-dependent data belongs at the context.

## Log where the failure is understood

When a call returns a Result, branch on `result.error` if the caller also needs to act on the success value. For a background operation with no awaiting caller, handle the rejection where the work starts. The [browser OAuth client](../../../packages/account/src/browser-oauth.ts) records why automatic renewal failed:

```ts
void authorizeOnce(true).catch((cause) => {
	log.error(BrowserOAuthDiagnostic.RenewalFailed({ cause }));
});
```

## Two anti-patterns, both already paid for

`grep -rn "consoleSink({" src/` and `grep -rn "log\.\(warn\|error\)(new Error" src/` before adding either.

### Do not call a sink directly

Sinks take a raw `LogEvent`, which constrains nothing. `createLogger` is what binds the `Logger` type, and the `Logger` type is the only thing enforcing that `warn`/`error` are unary over a `LoggableError`. Reaching past the factory to `consoleSink({ ts, level, source, message, data })` is not a shortcut to the same behavior: it is opting out of the contract.

Whispering did exactly this and grew a parallel `log` whose `warn(error: Error, data?: unknown)` silently dropped the error object whenever a caller passed the second argument. Nothing caught it, because nothing had promised anything. Import `createLogger`; import `consoleSink` only to compose it into a sink you pass to `createLogger`.

### Do not mint a `new Error` at a log call site

`log.warn(new Error('X failed', { cause }))` type-checks, because native `Error` satisfies `LoggableError` structurally. That escape hatch exists for migrating old `catch (e) { console.warn(e) }` sites, not for authoring new ones. A hand-built `Error` gives the sink a message string and no `name` worth filtering on, and the phrasing lives at the call site where the next similar failure will phrase it slightly differently.

Mint a `defineErrors` variant instead, owned by the module that owns the failure.

**The tell to watch for**: a boundary that types a failure callback as `(cause: unknown)` and ships no vocabulary with it. Every implementer must then invent a message, and `new Error` is the shortest way. If you declare such a callback, export its variants from the same file. An earlier Whispering callback illustrates the contract:

```ts
export const WhisperingBackgroundError = defineErrors({
  AppFailed: ({ cause }: { cause: unknown }) => ({
    message: 'Whispering app background work failed',
    cause,
  }),
});

export type WhisperingAppDependencies = {
  reportBackgroundError(cause: unknown): void;
};
```

Implementers then name a failure rather than describing one:

```ts
reportBackgroundError: (cause) => log.warn(WhisperingBackgroundError.AppFailed({ cause }))
```

## Log-only variants are not public API

Minting a variant is not the same as publishing one. Two kinds:

| | Returned in a `Result` | Only logged |
|---|---|---|
| Who sees it | Consumers, who branch on `.name` | A log sink |
| Export it? | Yes; renaming a variant is a breaking change | No, `const` at module scope |
| Examples | `AuthError.StartSignInFailed` | `BrowserOAuthDiagnostic.ListenerFailed` |

Exporting a log-only set publishes a name no one can import for a reason and freezes a string you should stay free to reword. Keep log-only sets private for exactly this; only errors that leave in a `Result` are in the published failure surface. Export a log-only set solely when a second file in the same package logs the same failure, and even then, only within the package.

**Name the variant key for the log line, not for the set.** `defineErrors` stamps `name` from the key alone; the `const` you assign the set to never reaches the sink. `createLogger`'s `source` supplies the namespace, so `[auth/browser-oauth] { name: 'ListenerFailed' }` reads fine and the key stays short.

**Prefer a field over interpolation.** `` new Error(`could not ${what}`) `` produces a message no two calls share. `ContainedStepFailed({ step: what, cause })` gives one constant message and a structured `step`.

### When the consumer is not a `Logger`

`log.warn(Variant({ cause }))` passes the `Err` wrapper, and `createLogger` unwraps it. A hand-narrowed reporter type does not:

An earlier `packages/lens` API accepted only `{ error(error: unknown): void }`. The reporter could read `name`, `message`, and `cause` directly when the caller passed `variant.error`. When maintaining a reporter with this contract, unwrap the Result before calling it.

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

Let the caller supply a logger when it needs a different sink. The [OAuth tests](../../../packages/account/src/browser-oauth.test.ts) give each test world its own `memorySink()` and pass `log: createLogger('auth/browser-oauth', logs.sink)` to the client options. Opening two tabs in that world sends both clients’ events to the same sink. A separate test world gets its own event list.

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

- `error-handling` skill: `trySync`/`tryAsync` patterns and the [error variants reference](../error-handling/references/error-variants.md) for the typed failures the logger consumes
- `rust-errors` skill: full `tracing` ↔ `Logger` mapping
- `tapErr` (from `wellcrafted/result`): Result-chain combinator that logs on the Err branch and passes the Result through. Rare in epicenter, since most call sites branch on `result.error` directly to use the data on the Ok branch. Reach for it only when the Result flows out of the function in a `.then(...)` chain.
