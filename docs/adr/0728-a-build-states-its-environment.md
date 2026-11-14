# 0728. A build states its environment

- **Status:** Superseded
- **Date:** 2026-11-03
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Amends:** [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) at "the environment comes from the bundle identifier's `.dev` suffix": the build's Tauri configuration states it; [ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md) at `EPICENTER_FOLDER_DIR` as a test override for standalone apps: the standalone shell reads no such variable.
- **Unbuilt:** none.

## Context

A standalone app's shell chose `~/Epicenter Dev` over `~/Epicenter` when its
bundle identifier ended in `.dev`, and stripped that suffix to find the app's
site (ADR-0722). An app whose host's first label is `dev`
(`dev.example.com`, identifier `com.example.dev`) then read as a development
build, so the shell refused such hosts. `EPICENTER_FOLDER_DIR` replaced the
root in debug builds for tests.

## Decision

**A build's Tauri configuration states its environment.** A development
configuration (`src-tauri/tauri.dev.conf.json`) says:

```json
"plugins": { "epicenter-standalone": { "environment": "development" } }
```

A configuration that says nothing is production. The shell reads it with
`Environment::from_config` (`packages/tauri-epicenter-standalone/src/data_folder.rs`);
any other value is an error at startup.

- **The root follows the environment:** `~/Epicenter` in production,
  `~/Epicenter Dev` in development.
- **The identifier's `.dev` is stripped only in development**, so a host whose
  first label is `dev` is an ordinary app.
- **No variable replaces the root.** Tests call the pure root and naming
  functions with explicit arguments.

## Consequences

- The `dev`-label refusal and the debug-only override are gone from the
  standalone shell.
- Each app's development configuration carries one more key, which the
  identity test in `packages/definition/src/site/standalone-identity.test.ts`
  checks.

## Considered alternatives

- **Infer the environment from the `.dev` suffix.** Needs a refusal of real
  hosts to stay unambiguous.
- **`cfg(debug_assertions)`.** Ties the folder to how the binary was compiled
  rather than which configuration it is, so a release build of the
  development configuration would write into `~/Epicenter`.
