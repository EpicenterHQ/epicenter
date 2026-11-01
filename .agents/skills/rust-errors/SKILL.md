---
name: rust-errors
description: Rust to TypeScript error handling for Tauri apps. Use when mentioning Rust errors, Tauri command errors, invoke errors, or defining Rust error types for TS consumption.
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

Use this skill when a Rust command returns failures that TypeScript consumes. The `tauri` skill owns command registration, generated bindings, capabilities, and native verification. The `error-handling` skill owns Result composition and presentation after the IPC boundary. The `logging` skill owns diagnostic levels and sinks.

## Let Rust define the failure

A command returns `Result<T, E>` when failure is part of its contract. Define an error variant when a caller can respond differently or needs structured data; keep operational detail in `message`. The recorder's `PermissionDenied`, `NoInputDevice`, and `Busy` variants are examples. Do not divide one frontend action into several variants merely to label different internal causes. An internal Rust error that never crosses IPC does not need Serde or Specta derives.

For a typed command error that crosses IPC, derive `serde::Serialize` and `specta::Type` from the same enum. Derive `Deserialize` only when the value also crosses back into Rust. An internally tagged enum such as `#[serde(tag = "name")]` gives TypeScript a discriminant for exhaustive handling:

```rust
#[derive(Debug, thiserror::Error, serde::Serialize, specta::Type)]
#[serde(tag = "name")]
pub enum RecordingError {
    #[error("{message}")]
    PermissionDenied { message: String },
    #[error("{message}")]
    Failed { message: String },
}
```

Keep the error non-nullable. Specta's `DataError` mode uses `null` to mean success and rejects nullable command error types during binding export. A success value may itself be nullable. Do not add a parallel ArkType schema or handwritten TypeScript union for a generated Rust error. Browser code can use explicit `import type` from the generated bindings without loading the Tauri runtime.

## Generate the application result shape

Epicenter's `make_specta_builder()` registers the commands and sets `ErrorHandlingMode::DataError`. The generated command returns `{ data: T, error: null } | { data: null, error: E }`, which is compatible with Wellcrafted's `Result<T, E>`. Callers branch on `error !== null`, forward an error they do not own, and let the interaction owner present the final outcome. Infallible commands retain their plain generated return type.

This mode changes the generated TypeScript API. Tauri still sends a Rust `Err` through its rejected IPC channel. The generated helper catches a non-`Error` rejection and casts it to `E`; it rethrows a JavaScript `Error`. Generation therefore establishes the compile-time contract, not runtime validation of every rejection. Do not present an unexpected thrown failure as a known Rust domain variant. Adapt a transport rejection only where an operation deliberately owns that failure meaning.

A consumer's command boundary combines generated commands with any handwritten raw-byte command. It must not reshape every generated command: `DataError` already produces the application Result. A raw `tauri::ipc::Response` command remains handwritten because Specta cannot export that response type. The standalone Whispering app no longer calls these commands; its shell registers none.

## Keep the generated contract in sync

A Rust command or error change must update `make_specta_builder()`, regenerate `apps/epicenter/src/ui/bindings.gen.ts` (the `export_bindings` test in `apps/epicenter/src-tauri/src/lib.rs` writes it), and review its diff. Generated types should change when the wire contract changes. Check the relevant TypeScript type assertions and the Epicenter consumer. Keep exhaustive `switch (error.name)` handling where a caller translates every variant.

The current `DataError` implementation is pinned to upstream Git revisions in `apps/epicenter/src-tauri/Cargo.toml` because it landed after the last published `tauri-specta` release. Replace those pins with released compatible versions when available; do not silently downgrade to the status-tagged mode while the generated callers expect `{ data, error }`.

Rust's `tracing` and TypeScript's `wellcrafted/logger` both choose severity at the emission site, not on the error variant. See `logging` for the diagnostic contract and the mapping below. A returned `Err` is not itself a log event; log where an owner can add context or where the failure would otherwise be invisible.

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
