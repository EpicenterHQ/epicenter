# 0756. An app's native shell is linked from its capabilities

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Relates:** [ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md) (a capability keeps its TypeScript and its Rust plugin in one directory), [ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) (the composition in `app.ts`), [ADR-0753](0753-an-app-declares-what-it-is-and-what-it-needs-the-platform-supplies-where-how-and-when.md) (an app declares what it needs), [ADR-0701](0701-apps-run-as-separate-programs.md) (each app ships its own desktop program), [ADR-0723](0723-an-apps-site-is-found-by-convention.md) (the site publishes `/contract.json`).
- **Unbuilt:** the `package.json` key a capability declares its plugin in; the build step that writes the shell's `main.rs` and Tauri permissions from an app's dependencies; `native/` in any app; the build publishing `/contract.json` from `contract.ts` in place of each app's `scripts/write-contract.ts`; `epicenter new`; a home for the bundle settings `src-tauri/` holds today.

## Context

Saying "Whispering records" takes four edits today: `@epicenter/recorder`
in `apps/whispering/package.json`, `tauri-plugin-epicenter-recorder` in
`apps/whispering/src-tauri/Cargo.toml`,
`.plugin(tauri_plugin_epicenter_recorder::init())` in
`apps/whispering/src-tauri/src/main.rs`, and `epicenter-recorder:default`
in `apps/whispering/src-tauri/capabilities/whispering.json`. Each desktop
app repeats the same registrations for the same plugins.

Whispering's `src-tauri/src` holds 507 lines of Rust. Of its four files,
only `shortcut.rs` (77 lines), the global shortcut, is a feature no
capability covers.

Each app publishes its contract through a script of its own:
`apps/whispering/scripts/write-contract.ts` writes `static/contract.json`
from the contract in `apps/whispering/src/lib/contract.ts`, and Capture,
Honeycrisp, Messages, Todos, and Vocab do the same.

React Native solved the same repetition with autolinking: its CLI reads each
dependency's declaration and generates the native code that links its
module, so adding a native module is adding a dependency.

## Decision

**A capability package declares its Rust plugin in its `package.json`, and
the build generates the shell's `main.rs` and Tauri permissions from the
app's dependencies.** Adding `@epicenter/recorder` to an app's
dependencies registers `tauri-plugin-epicenter-recorder` and grants its
permissions. Removing the dependency removes both.

**An app's `src-tauri/` shrinks to `native/`,** which holds only Rust for
features no capability covers. An app with none has no `native/`.

**An app's layout:**

```txt
<app>/
  contract.ts     what the app's files are; the build publishes it as /contract.json
  app.ts          the capabilities it needs, composed once for every platform (ADR-0754)
  routes/         its screens
  native/         Rust for features no capability covers, such as Whispering's global shortcut
```

**`epicenter new` writes the common `app.ts` into a new app; no
`@epicenter/app` package wraps the capabilities.** The composition is the
three lines in
[ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md),
and an app edits them as its own code.

## Consequences

- Adding or removing a capability is one dependency edit. An app's
  permissions are what its dependencies declare.
- The shell's `main.rs` is a build output. A reader looks in `native/` for
  the Rust that is the app's own.
- Epicenter maintains a build step Tauri does not provide. A change to how
  Tauri registers plugins or names permissions breaks it for every app at
  once.
- Every `scripts/write-contract.ts` and committed `static/contract.json`
  goes; the build writes `/contract.json` from `contract.ts`.
- An app keeps the `app.ts` it was created with. A change to the common
  composition is a change to each app's few lines, not a version bump of a
  wrapper.
- `src-tauri/` also holds bundle settings today: `tauri.conf.json`,
  `Info.plist`, entitlements, and icons. Each needs a source outside
  `native/` or a place in it, decided when the build step is written.

## Considered alternatives

- **A hand-written shell per app (today).** Four files per capability, and
  every app's `main.rs` repeats the same registrations.
- **An `@epicenter/app` package that wraps the capabilities.** The
  composition is a few lines, and a wrapper grows an option for every knob a
  capability has.
- **One shared shell crate with every plugin behind a Cargo feature.** An
  app's features restate its dependencies in a second place.
