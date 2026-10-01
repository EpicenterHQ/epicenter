---
name: error-handling
description: 'Use when a task mentions error handling, Wellcrafted Results, result types, defineErrors, trySync, tryAsync, unwrap, thrown exceptions, or deciding whether to propagate, recover from, or present a failure. For recording diagnostics, use logging; for cache lifecycle, use query-layer.'
metadata:
  author: epicenter
  version: '3.1'
---

# Error Handling

Epicenter uses Wellcrafted Results as its internal contract for ordinary failures. This skill owns the full path: define a tagged failure, adapt a throwing dependency, compose or recover from Results, then consume the outcome at the boundary that serves a person or another API. Use `logging` for diagnostics, `query-layer` for TanStack observation and cache behavior, and `hono` for HTTP response mechanics.

## Source Of Truth

Ground every Wellcrafted behavior claim in the official [wellcrafted-dev/wellcrafted](https://github.com/wellcrafted-dev/wellcrafted/) source and tests. When maintaining this guidance, confirm that Epicenter's installed version matches the source being read. If it does not, report the version drift; dependency freshness is handled outside this skill. Treat other skills, examples, generated documentation, and DeepWiki as leads, not authority.

Read the scoped references only when needed:

- Read [error variants](references/error-variants.md) when designing `defineErrors` variants, their fields, messages, or union types, or when translating an entire tagged error union.
- Read [references/wrapping-boundaries.md](references/wrapping-boundaries.md) when deciding how much work one `trySync` or `tryAsync` should cover, especially around cleanup.
- Read [references/toast-on-error.md](references/toast-on-error.md) when presenting tagged failures in UI code.
- Read [references/http-boundaries.md](references/http-boundaries.md) when mapping failures into Hono responses or deciding which exceptions must keep propagating.

## Carry the outcome until a caller settles it

Fallible application work returns `Result<T, E>` while its caller can recover, add context, or choose how to present the outcome. Compose operations by handling or forwarding each possible `Err`. Preserve a lower error unless the current operation owns a meaningful new failure. An intentional fallback can return `Ok`, and a partial success may need success data that records what degraded, so the final caller can respond accurately.

The interaction owner consumes the final outcome into UI state, a toast, an HTTP response, or another host contract. That owner is determined by responsibility and lifetime, not by whether the code lives in an `onclick` attribute or an `operations` directory. A terminal action can return `void` or `Promise<void>` after settling the outcome. Infallible work stays plain, and unexpected bugs must not become routine `Err` values.

Do not treat every consumption boundary as an `unwrap`. Branch on the Result when the caller presents or recovers from an error. Use `unwrap` when the receiving API already communicates failure by throwing.

## Choose The Contract First

| Required contract | Pattern |
| --- | --- |
| Callee already returns `Result<T, E>` | Inspect or forward its `Err`; do not wrap the call in `trySync` or `tryAsync` |
| Callee throws but caller needs `Result<T, E>` | Adapt the throwing operation with `trySync` or `tryAsync` |
| Failure has a valid fallback | Return `Ok(fallback)` from `catch` |
| Failure must propagate as data | Return a typed `defineErrors` factory result from `catch` |
| Only known external failures should become `Err` | Map known exceptions and rethrow unknown ones |
| Surrounding API is exception-based | Keep its throwing contract |
| Cleanup must run on success, failure, cancellation, or early return | Use `finally` |

Use `trySync` for a synchronous operation and `tryAsync` for an operation returning a Promise.

```ts
const { data: response, error } = await tryAsync({
	try: () => fetch(url),
	catch: (cause) => RequestError.TransportFailed({ cause }),
});
if (error !== null) return Err(error);
return Ok(response);
```

`defineErrors` factories already return `Err(...)`. Pass the raw `cause` into the factory and let the factory compose its message with `extractErrorMessage`. Do not use raw `Err(cause)` at a catch boundary: thrown values may be `null` or `undefined`, and an untyped cause loses the domain failure.

## Cross a deliberate throwing boundary

Keep a `Result` as data while the caller can still recover, report, retry, or
propagate. Use `unwrap` only where the surrounding API already throws as its
failure channel:

```ts
import { unwrap } from 'wellcrafted/result';

const document = unwrap(await openDocument(id));
```

`unwrap` returns `Ok.data` and throws `Err.error`. The throw is the boundary's
contract, not a sign the failure was unexpected. Guard on `error !== null`
instead when this function must recover, add context, or clean up.

A conceptual sketch is the one exception: `unwrap` may stand in for Result
branches that do not change the behavior being explained. Say that the sketch
throws on failure, and show the branch whenever a failure changes that
behavior, such as keeping an unsaved draft after a save conflict.

## Consume Every Possible Err Branch

- If a value can be `Result<T, E>`, inspect or deliberately forward its error branch.
- After destructuring, `error` is the raw `E`. Return `Err(error)`, not `error`.
- If you retained the whole Result, return it unchanged: `if (result.error !== null) return result`.
- `error !== null` is the reliable discriminator. Never construct `Err(null)` or `Err(undefined)`.
- Data-only destructuring is correct when the catch branch always returns `Ok<T>` and the inferred type collapses to `Ok<T>`.
- Error-only destructuring is correct when success data is irrelevant. The rule is to handle every possible `Err`, not to destructure fields you do not use.

Prefer an immediate guard so the success path stays linear.

When a caller translates every variant of a tagged error union, use an exhaustive `switch (error.name)` with `default: error satisfies never`. A guard for one variant followed by a shared path is different. See [error variants](references/error-variants.md) for both shapes.

## Own The Promise

`tryAsync` returns a Promise. Choose its owner explicitly:

- `await` when this function inspects the Result.
- `return tryAsync(...)` when the caller owns the `Promise<Result<...>>`.
- Do not use bare `void tryAsync(...)`: ordinary failures fulfill with `Err`, so a Promise rejection handler cannot observe them. A best-effort operation still needs an async owner that awaits the Result and explicitly logs or ignores its error branch.
- In UI fire-and-forget code, attach presentation before discarding a Promise that fulfills with a Result: `void save().then((result) => toastOnError(result, 'Save failed'))`. If the Promise can reject, adapt or catch that rejection first.

## Keep Native Try-Catch When It Expresses The Contract

Traditional `try-catch` is appropriate when:

- a `finally` block owns cleanup;
- a generator must `yield` a failure rather than return a Result;
- a framework boundary converts an exception directly into its required response shape;
- code catches one known exception and rethrows everything else;
- the surrounding public API intentionally throws.

Do not turn unknown programming errors into a generic domain failure. Mapping every throw to `Err` can hide bugs behind a misleading retryable error.

## Final Check

1. The function's throw-versus-Result contract is explicit.
2. The wrapper covers one coherent failure meaning.
3. Caught values become typed errors, intentional fallbacks, or selective rethrows.
4. Every possible `Err` branch is handled, forwarded, logged, presented, or explicitly ignored by a named best-effort owner.
5. Unknown bugs still reach the appropriate crash or framework error boundary.
