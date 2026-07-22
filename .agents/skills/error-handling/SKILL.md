---
name: error-handling
description: Adapt thrown or rejected operations into wellcrafted Results and consume Result values without swallowing failures. Use when replacing try-catch, adding trySync or tryAsync, choosing fallback versus typed propagation or selective rethrow, forwarding Err, handling fire-and-forget promises, mapping known failures at HTTP boundaries, or surfacing tagged errors with toastOnError.
metadata:
  author: epicenter
  version: '3.1'
---

# Error Handling

This skill owns the boundary between thrown exceptions and `Result` values, plus correct `Result` consumption. Compose with `define-errors` for variant design, `logging` for diagnostics, `query-layer` for RPC presentation, and `hono` for response APIs.

## Source Of Truth

Ground every Wellcrafted behavior claim in the official [wellcrafted-dev/wellcrafted](https://github.com/wellcrafted-dev/wellcrafted/) source and tests. When maintaining this guidance, confirm that Epicenter's installed version matches the source being read. If it does not, report the version drift; dependency freshness is handled outside this skill. Treat other skills, examples, generated documentation, and DeepWiki as leads, not authority.

Read the scoped references only when needed:

- Read [references/wrapping-boundaries.md](references/wrapping-boundaries.md) when deciding how much work one `trySync` or `tryAsync` should cover, especially around cleanup.
- Read [references/toast-on-error.md](references/toast-on-error.md) when presenting tagged failures in UI code.
- Read [references/http-boundaries.md](references/http-boundaries.md) when mapping failures into Hono responses or deciding which exceptions must keep propagating.

## Choose The Contract First

| Required contract | Pattern |
| --- | --- |
| Caller receives `Result<T, E>` | Adapt the throwing operation with `trySync` or `tryAsync` |
| Failure has a valid fallback | Return `Ok(fallback)` from `catch` |
| Failure must propagate as data | Return a typed `defineErrors` factory result from `catch` |
| Only known external failures should become `Err` | Map known exceptions and rethrow unknown ones |
| Surrounding API is exception-based | Keep `try-catch`, or unwrap only at that boundary |
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

## Consume Every Possible Err Branch

- If a value can be `Result<T, E>`, inspect or deliberately forward its error branch.
- After destructuring, `error` is the raw `E`. Return `Err(error)`, not `error`.
- If you retained the whole Result, return it unchanged: `if (result.error !== null) return result`.
- `error !== null` is the reliable discriminator. Never construct `Err(null)` or `Err(undefined)`.
- Data-only destructuring is correct when the catch branch always returns `Ok<T>` and the inferred type collapses to `Ok<T>`.
- Error-only destructuring is correct when success data is irrelevant. The rule is to handle every possible `Err`, not to destructure fields you do not use.

Prefer an immediate guard so the success path stays linear.

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
