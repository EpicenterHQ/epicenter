# Rust command errors across Tauri IPC

Use this reference when a Rust command returns failures that TypeScript consumes. The `tauri` skill owns command registration, generated bindings, capabilities, and native verification. The `error-handling` skill owns Result composition and presentation after the IPC boundary. The `logging` skill owns diagnostic levels and sinks.

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

Keep the error non-nullable. Specta's `DataError` mode uses `null` to mean success and rejects nullable command error types during binding export. A success value may itself be nullable. Do not add a parallel ArkType schema or handwritten TypeScript union for a generated Rust error. The narrow browser-safe copies in Whispering's `commands.types.ts` are a platform exception checked against generated bindings by `commands.test-d.ts`.

## Generate the application result shape

Epicenter's `make_specta_builder()` registers the commands and sets `ErrorHandlingMode::DataError`. The generated command returns `{ data: T, error: null } | { data: null, error: E }`, which is compatible with Wellcrafted's `Result<T, E>`. Callers branch on `error !== null`, forward an error they do not own, and let the interaction owner present the final outcome. Infallible commands retain their plain generated return type.

This mode changes the generated TypeScript API. Tauri still sends a Rust `Err` through its rejected IPC channel. The generated helper catches a non-`Error` rejection and casts it to `E`; it rethrows a JavaScript `Error`. Generation therefore establishes the compile-time contract, not runtime validation of every rejection. Do not present an unexpected thrown failure as a known Rust domain variant. Adapt a transport rejection only where an operation deliberately owns that failure meaning.

`apps/whispering/src/lib/tauri/commands.ts` combines generated commands with one handwritten raw-byte command. It must not reshape every generated command: `DataError` already produces the application Result. The raw `tauri::ipc::Response` command remains handwritten because Specta cannot export that response type.

## Keep the generated contract in sync

A Rust command or error change must update `make_specta_builder()`, regenerate both `apps/whispering/src/lib/tauri/bindings.gen.ts` and `apps/epicenter/src/ui/bindings.gen.ts`, and review their diffs. Generated types should change when the wire contract changes. Check the relevant TypeScript type assertions and both consumers. Keep exhaustive `switch (error.name)` handling where a caller translates every variant.

The current `DataError` implementation is pinned to upstream Git revisions in `apps/epicenter/src-tauri/Cargo.toml` because it landed after the last published `tauri-specta` release. Replace those pins with released compatible versions when available; do not silently downgrade to the status-tagged mode while the generated callers expect `{ data, error }`.

Rust's `tracing` and TypeScript's `wellcrafted/logger` both choose severity at the emission site, not on the error variant. See `logging` for the diagnostic contract. A returned `Err` is not itself a log event; log where an owner can add context or where the failure would otherwise be invisible.
