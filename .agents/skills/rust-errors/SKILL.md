---
name: rust-errors
description: Use when working with Rust errors, Tauri command failures, invoke errors, or Rust error types consumed by TypeScript.
metadata:
  author: epicenter
  version: '1.0'
---

# Rust to TypeScript Error Handling
## Reference Repositories

- [Tauri](https://github.com/tauri-apps/tauri): Desktop app framework (source of Rust-to-TypeScript error patterns)

## Upstream Grounding

When Rust error serialization, Tauri command error transport, IPC payload shape, generated bindings, or frontend invoke error behavior affects correctness, use source-backed grounding before relying on memory. If DeepWiki MCP is available, ask a narrow question against `tauri-apps/tauri`; if it is unavailable or the repo is not indexed, use upstream source or official docs directly. Treat DeepWiki as orientation, then verify decisive details against local Rust code, generated bindings, installed crates, TypeScript types, source, or official docs before changing code.

Skip DeepWiki for local error naming conventions already documented below.

## Discriminated Union Pattern for Errors

When passing errors from Rust to TypeScript through Tauri commands, use internally-tagged enums to create discriminated unions that TypeScript can handle naturally.

### Rust Error Definition

```rust
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug, Serialize, Deserialize)]
#[serde(tag = "name")]
pub enum TranscriptionError {
    #[error("Audio read error: {message}")]
    AudioReadError { message: String },

    #[error("GPU error: {message}")]
    GpuError { message: String },

    #[error("Model load error: {message}")]
    ModelLoadError { message: String },

    #[error("Transcription error: {message}")]
    TranscriptionError { message: String },
}
```

### Key Rust Patterns

1. **Use internally tagged enums**: `#[serde(tag = "name")]` creates a discriminator field
2. **Follow naming conventions**: Enum variants should be PascalCase
3. **Include structured data**: Each variant can have fields like `message: String`
4. **Single-variant enums are okay**: Use when you want consistent error structure

```rust
// Single-variant enum for consistency
#[derive(Error, Debug, Serialize, Deserialize)]
#[serde(tag = "name")]
enum ArchiveExtractionError {
    #[error("Archive extraction failed: {message}")]
    ArchiveExtractionError { message: String },
}
```

### TypeScript Error Handling

The rejected value from `invoke` is `unknown`. Validate a serialized domain
error before treating it as the Rust enum. A matching error can remain a tagged
failure in the operation's Result; a malformed payload needs a failure owned by
the IPC boundary. Neither case decides the UI title or action. The interaction
owner makes that decision after receiving the Result. See [error-handling](../error-handling/SKILL.md)
for exception adaptation, propagation, and presentation.

```typescript
import { type } from 'arktype';

// Define the error type to match Rust serialization
const TranscriptionErrorType = type({
	name: "'AudioReadError' | 'GpuError' | 'ModelLoadError' | 'TranscriptionError'",
	message: 'string',
});
```

When an operation converts the rejection to a Result, its `tryAsync` catch
callback returns a typed `Err`: forward a validated domain error with
`Err(error)`, or return a boundary-owned `defineErrors` variant for an invalid
payload. If the operation translates every domain variant to a different
failure, use an exhaustive switch with `default: error satisfies never`.

### Serialization Format

The Rust enum serializes to this TypeScript-friendly format:

```json
// AudioReadError variant
{ "name": "AudioReadError", "message": "Failed to decode audio file" }

// GpuError variant
{ "name": "GpuError", "message": "GPU acceleration failed" }
```

### Best Practices

1. **Consistent error structure**: All errors have the same shape with `name` and `message`
2. **TypeScript type safety**: Use runtime validation with arktype to ensure type safety
3. **Exhaustive handling**: A switch translating every variant needs a `satisfies never` default to make new variants fail typechecking
4. **Don't use `content` attribute**: Avoid `#[serde(tag = "name", content = "data")]` as it creates nested structures
5. **Keep enums private when possible**: Only make public if used across modules

## Tauri Command Surface Rules

For Tauri commands that generate TypeScript bindings:

- Derive `Serialize`, `Deserialize` when the value crosses the IPC boundary both ways.
- Derive `specta::Type` for command inputs, outputs, and event payloads that appear in generated bindings.
- Keep the Rust enum variant name aligned with the TypeScript discriminant unless there is a deliberate `#[serde(rename = "...")]`.
- Keep a precise failure message and useful fields on the Rust variant; the app decides what a person sees. Do not make TypeScript reconstruct Rust context from separate fields unless the caller needs structured handling.
- Register events in the Tauri specta builder even if the event type is not returned by a command.

Generated bindings are a contract check, not just output. If a Rust change should alter the TypeScript command or event surface, regenerate bindings and review the generated diff. If the generated diff is large but the public IPC shape did not change, stop and find why before committing it.

### Anti-Patterns to Avoid

```rust
// DON'T: External tagging (default behavior)
#[derive(Serialize)]
pub enum BadError {
    ModelLoadError { message: String }
}
// Produces: { "ModelLoadError": { "message": "..." } }

// DON'T: Adjacent tagging with content
#[derive(Serialize)]
#[serde(tag = "type", content = "data")]
pub enum BadError {
    ModelLoadError { message: String }
}
// Produces: { "type": "ModelLoadError", "data": { "message": "..." } }

// DON'T: Manual Serialize implementation when derive works
impl Serialize for MyError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Unnecessary complexity
    }
}
```

This pattern ensures clean, type-safe error handling across the Rust-TypeScript boundary with minimal boilerplate and maximum type safety.

## `tracing` ↔ `wellcrafted/logger`

`defineErrors` mirrors `thiserror`; the workspace logger mirrors `tracing`. Together they give TypeScript the same split Rust has: errors are data, level is chosen at the emit site.

### Level mapping (5 levels, no `fatal`)

| `tracing` macro | Workspace `Logger` method | Use when |
|---|---|---|
| `tracing::trace!(...)` | `log.trace(message, data?)` | Per-token / per-message noise for deep debugging |
| `tracing::debug!(...)` | `log.debug(message, data?)` | Internal state transitions (handshakes, cache fills) |
| `tracing::info!(...)` | `log.info(message, data?)` | Lifecycle events (connected, loaded, flushed) |
| `tracing::warn!(?err)` | `log.warn(err)` | Recoverable failure: retry path, fallback taken |
| `tracing::error!(?err)` | `log.error(err)` | Unrecoverable at this layer: call it loudly |

`tracing` has no `fatal`; neither do we. Process termination is the app's decision (`process.exit`), not the library's.

### Level on the variant? No.

```rust
// Rust: level is on the CALL, not the enum variant
tracing::warn!(?err, "cache miss"); // same err, different sites
tracing::error!(?err, "giving up");
```

```ts
// TS: same rule
log.warn(CacheError.Miss({ key }));  // recoverable
log.error(CacheError.Miss({ key })); // terminal
```

No Rust logging crate attaches level to the error type (`thiserror`, `anyhow`, `slog`, `log`). `miette` is the exception, but it is a compiler-diagnostics library, not a general logger. We follow `tracing`: level is context, not identity.

### The `?err` idiom ↔ `tapErr`

`tracing`'s `?err` interpolates a structured error field into the log event. In TS, the Result-flow equivalent is `tapErr` (from `wellcrafted/result`):

```rust
let result = do_thing().inspect_err(|err| tracing::warn!(?err, "do_thing failed"));
```

```ts
import { tapErr } from 'wellcrafted/result';

const result = await tryAsync({
  try: () => doThing(),
  catch: (cause) => DoThingError.Failed({ cause }),
}).then(tapErr(log.warn));
```

Both: pass-through on success, log the structured error on failure.

In practice this shape is rare in epicenter. Most call sites need the Ok data locally and so branch on `result.error` and log inside the branch. Reach for `tapErr` only when the Result flows out of the function in a `.then(...)` chain.
