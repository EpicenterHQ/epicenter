# Whispering App

Svelte 5 speech-to-text SPA served by the Epicenter desktop host, which owns its only native Tauri runtime. `bun dev:whispering` runs the same SPA in a browser tab for development.

## Key Points

- Three-layer architecture: Service -> Query -> UI
- Services are pure functions returning `Result<T, E>`
- Load `platform-seams` when changing build selection. Native capabilities use an `epicenter-host` leaf and an actual browser implementation or explicit absence in `default`. Keep both targets typechecked and update `src/lib/platform-selection.test.ts`; a browser build must never invoke native APIs. Every build opens its own store. Use `resolve` from `$app/paths` for application paths.
- Tauri-only capabilities live in `$lib/tauri.tauri.ts`; shared consumers go through `#platform/*`.
- Query layer handles reactivity, caching, and error transformation
- See `ARCHITECTURE.md` for detailed patterns

## Don'ts

- Don't put business logic in Svelte components
- Don't access settings directly in services (pass as parameters)
- Don't use try-catch; use wellcrafted Result types

## Tauri Commands

Load `tauri` before adding or changing Tauri commands, permissions,
capabilities, generated bindings, or platform filesystem behavior. Load
`rust-errors` when a command changes Rust error payloads consumed by
TypeScript.

Every command change must keep `make_specta_builder()` in
`../epicenter/src-tauri/src/lib.rs`, generated bindings, and
`src/lib/tauri/commands.ts` in sync. The command boundary file is the only place
in `src/lib/**` that may import `invoke` from `@tauri-apps/api/core` for app
commands.

## Specs and Docs

- App-specific specs: `./specs/`
- App-specific docs: `./docs/` (if needed)
- Cross-cutting specs: `/specs/`
- Cross-cutting docs: `/docs/`

See root `AGENTS.md` for the full organization guide.
