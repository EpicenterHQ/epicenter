# Error variants with defineErrors

The [error-handling skill](../SKILL.md) owns Result composition and boundary decisions. This reference covers variant construction, fields, and types. See `services-layer` for service architecture and namespace exports.

Ground API claims in the official `wellcrafted-dev/wellcrafted` source and
tests for Epicenter's installed version. `logging` owns diagnostic severity
and sinks.

## Import

```typescript
import {
  defineErrors,
  extractErrorMessage,
  type InferErrors,
  type InferError,
} from 'wellcrafted/error';
```

## Core Rules

1. Put the variants for one public failure contract in **one `defineErrors` call**. Separate contracts, such as KV read and write failures, may each have their own namespace, even when each has one variant
2. The factory function **returns `{ message, ...fields }`**: that is the entire API; no `.withMessage()`, `.withContext()`, or `.withCause()` chains
3. **`cause: unknown`** is just a field like any other: accept it in the input and forward it in the return object
4. When a factory accepts a cause, **call `extractErrorMessage(cause)` inside the factory** so call sites pass the raw value
5. Each call like `MyError.Variant({ ... })` **returns `Err(...)` automatically**: no separate `FooErr` pair
6. **Shadow the const with a same-name type** using `InferErrors`: `const FooError` / `type FooError`
7. Use `InferError<typeof FooError.Variant>` to extract a single variant's type when needed
8. Prefer a name that identifies the failure mode when callers can distinguish or act on it. A single `Failed` variant is acceptable when the contract exposes one deliberately undifferentiated failure
9. Let the public failure contract determine the variant count. Do not merge distinct actionable failures merely to hit a small number, and do not split one failure into artificial variants
10. **Write `.message` for its actual consumers**: variants that reach `toastOnError` or `$lib/report` need safe, readable user copy. Diagnostic-only variants may be technical because the logger is their consumer. Do not assume every tagged error is user-facing. For presented errors, avoid raw paths, status codes, or stack traces as the primary message. Put necessary technical detail after a human-readable prefix:

```typescript
// Good: human-readable prefix, technical detail after
message: `Could not save recording: ${extractErrorMessage(cause)}`

// Bad: raw technical output as the entire message
message: `POST /api/recordings 500: ${extractErrorMessage(cause)}`
```

## Patterns

### 1. Simple variant: no input, static message

```typescript
export const RecorderError = defineErrors({
  AlreadyRecording: () => ({
    message: 'A recording is already in progress',
  }),
});
export type RecorderError = InferErrors<typeof RecorderError>;

// Call site
return RecorderError.AlreadyRecording();
```

### 2. Variant with structured fields: message computed from input

```typescript
export const DbError = defineErrors({
  NotFound: ({ table, id }: { table: string; id: string }) => ({
    message: `${table} '${id}' not found`,
    table,
    id,
  }),
});
export type DbError = InferErrors<typeof DbError>;

// Call site
return DbError.NotFound({ table: 'users', id: '123' });
// error.message -> "users '123' not found"
// error.table   -> "users"
// error.id      -> "123"
```

### 3. Variant with cause: extractErrorMessage inside the factory

```typescript
import { extractErrorMessage } from 'wellcrafted/error';

export const FfmpegError = defineErrors({
  CompressFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to compress audio: ${extractErrorMessage(cause)}`,
    cause,
  }),
  VerifyFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to verify temp file: ${extractErrorMessage(cause)}`,
    cause,
  }),
});
export type FfmpegError = InferErrors<typeof FfmpegError>;

// Call sites pass the raw cause; the factory owns message construction.
function compressionFailure(cause: unknown) {
  return FfmpegError.CompressFailed({ cause });
}
```

### 4. Multiple variants in one object: discriminated union built-in

```typescript
export const DeviceStreamError = defineErrors({
  PermissionDenied: ({ cause }: { cause: unknown }) => ({
    message: `Microphone permission denied. ${extractErrorMessage(cause)}`,
    cause,
  }),
  DeviceConnectionFailed: ({
    deviceId,
    cause,
  }: {
    deviceId: string;
    cause: unknown;
  }) => ({
    message: `Unable to connect to device '${deviceId}'. ${extractErrorMessage(cause)}`,
    deviceId,
    cause,
  }),
  NoDevicesFound: () => ({
    message: "No microphones found. Check your connections and try again.",
  }),
});
export type DeviceStreamError = InferErrors<typeof DeviceStreamError>;
// DeviceStreamError is automatically the union of all three variants

// Extracting a single variant type
type NoDevicesFoundError = InferError<typeof DeviceStreamError.NoDevicesFound>;
```

### 5. Domain errors with specific operation failures

```typescript
export const FsError = defineErrors({
  ReadFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
    message: `Failed to read '${path}': ${extractErrorMessage(cause)}`,
    path,
    cause,
  }),
  WriteFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
    message: `Failed to write '${path}': ${extractErrorMessage(cause)}`,
    path,
    cause,
  }),
  DeleteFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
    message: `Failed to delete '${path}': ${extractErrorMessage(cause)}`,
    path,
    cause,
  }),
});
export type FsError = InferErrors<typeof FsError>;

// Call site
return FsError.ReadFailed({ path: '/tmp/foo.txt', cause: error });
```

## Type Extraction

```typescript
// Full union type for all variants
type HttpError = InferErrors<typeof HttpError>;

// Single variant type
type ConnectionError = InferError<typeof HttpError.Connection>;
```

## Consuming a Variant Union: Exhaustive `switch`, Not `if/else`

`defineErrors` builds a discriminated union tagged by `name`. When you *translate the whole union* (every variant mapped to another error, an exit code, a UI state), discriminate with an exhaustive `switch (error.name)` and pin it with `default: error satisfies never`. Do not use an `if/else` chain.

```ts
// ❌ non-exhaustive fold: a 6th DispatchError variant lands in `else` silently
if (result.error.name === 'RecipientOffline') {
  return RunError.PeerNotFound({ peerTarget, waitMs, syncStatus });
}
return RunError.RemoteCallFailed({ cause: result.error, peerTarget, syncStatus });

// ✅ exhaustive: a 6th variant fails to compile until someone buckets it
switch (result.error.name) {
  case 'RecipientOffline':
    return RunError.PeerNotFound({ peerTarget, waitMs, syncStatus });
  case 'ActionNotFound':
  case 'ActionFailed':
  case 'Cancelled':
  case 'NetworkFailed':
    return RunError.RemoteCallFailed({ cause: result.error, peerTarget, syncStatus });
  default:
    return result.error satisfies never;
}
```

**Why**: error unions grow. The `satisfies never` default makes the *producer* adding a variant break the *consumer's* build, forcing a deliberate decision instead of a silent fall-through into the catch-all branch. Collapsing several variants into one output is fine: list their `case` labels explicitly so the collapse is visible and intentional.

### Not every `error.name === 'X'` is wrong

Two shapes are legitimate and should stay as an `if` or a plain expression:

- **Predicate**: one boolean about one variant.
  ```ts
  get isCreditsExhausted() {
    return chat.error instanceof AiChatHttpError
      && chat.error.detail.name === 'InsufficientCredits';
  }
  ```
- **Guard**: special-case one variant, then let the rest flow through a
  shared path.
  ```ts
  if (result.error.name === 'Throttled') {
    await waitFor(result.error.retryAfterMs);
    return retry();
  }
  // every other variant flows to the shared handling below
  ```

The smell is specifically the **total fold**: every branch consumes the union into a different output, with no compiler pin. If you are translating the whole union, switch on it. This is not error-specific: the same rule applies to any closed discriminated union (state enums keyed by `kind`, `phase`, or `state`). See `code-audit` category 7 for the detection grep recipe.

## Avoid Parallel Error Envelopes

When an internal function or a boundary that explicitly adopts Wellcrafted
needs to signal success or failure, do not invent a parallel
`{ ok: true, data } | { ok: false, error }` shape. This codebase already uses
`Result<T, E>` (`{ data: T, error: null } | { data: null, error: E }`). External
protocols keep their own established envelopes.

```ts
// Wrong: parallel invention to Result<T, E>
type CallResult<T> =
  | { ok: true;  data: T }
  | { ok: false; error: { name: string; message: string } };
```

```ts
// Right: use Result + defineErrors
import type { Result } from 'wellcrafted/result';
import { defineErrors, type InferErrors } from 'wellcrafted/error';

export const CallError = defineErrors({
  Timeout: ({ timeoutMs }: { timeoutMs: number }) => ({
    message: `timed out after ${timeoutMs}ms`,
    timeoutMs,
  }),
  // ...
});
export type CallError = InferErrors<typeof CallError>;

type CallResult<T> = Result<T, CallError>;
```

**Why**: Result consumers such as `isOk`, `isErr`, `unwrap`, `tapErr`, and the
`wellcrafted/query` adapters expect `{ data, error }`. An ad hoc `{ ok }`
return cannot use them and forces every consumer to learn another shape.
`trySync` and `tryAsync` adapt throwing operations, while the [main skill](../SKILL.md)
owns how existing Results compose.

**Wire-format boundary**: an internal RPC or IPC surface that explicitly adopts
Wellcrafted Result can serialize `{ data, error }` and the tagged
`{ name, message, ...fields }` error directly. That does not make this the
universal HTTP envelope. External protocols and existing routes keep their own
wire contracts; see [HTTP boundaries](http-boundaries.md).

**State machines are not Results**: discriminated unions like `{ state: 'in-use' | 'orphan' | 'clean' }` for a startup gate, or `{ outcome: 'graceful' | 'sigterm' }` for a shutdown, are genuine state enums and should stay as discriminated unions. The smell is *errors* dressed as `{ ok }` flags, not state enums.

## Reserved field name: `name`

`name` is reserved at the type level: TypeScript errors if you return it from a factory, because the factory stamps it from the variant key.

```ts
// Type error: factory would overwrite this anyway
defineErrors({
  Bad: () => ({ message: 'x', name: 'override' }),
});

// ✅ Fine
defineErrors({
  Good: ({ path, payload }: { path: string; payload: unknown }) => ({
    message: `failed at ${path}`,
    path,
    payload,
  }),
});
```

### Soft convention: avoid `data` as a field name

`Err<E>` carries a `data: null` at the wrapper level (it's how the shape distinguishes `Err` from `Ok`). A variant body with its own `data` field is visually confusing: `err.data` (the wrapper's null) shadows `err.error.data` (your field) in every reader's head.

This is **not** type-enforced. An earlier Wellcrafted change tried to reserve `data` and was reverted because the logger's `"name" in err` discriminator does not depend on that reservation. Prefer `payload`, `body`, `value`, or a domain-specific name like `path`, `response`, or `input`.

## Non-Null Variant Errors

A `defineErrors` variant factory returns `Err(...)` around a non-null tagged
object. That makes the variant safe for Wellcrafted's `error !== null`
discriminator. Choosing whether a caught value becomes that variant, a
fallback, a selective rethrow, or an exception-based framework response belongs
to the [main skill](../SKILL.md).
