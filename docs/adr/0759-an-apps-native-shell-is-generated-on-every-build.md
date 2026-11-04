# 0759. An app's native shell is generated on every build

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0756](0756-an-apps-native-shell-is-linked-from-its-capabilities.md) at `native/`, the app layout, and the bundle settings left without a source: the whole shell, not only `main.rs` and permissions, is generated on every build and never committed, and app-specific native code lives in `modules/<name>/`; [ADR-0753](0753-an-app-declares-what-it-is-and-what-it-needs-the-platform-supplies-where-how-and-when.md) at "stays the app's own, per platform, in `native/`": it lives in `modules/<name>/`.
- **Relates:** [ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md) (a capability keeps its TypeScript and its Rust plugin in one directory), [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) (names from the site's host), [ADR-0738](0738-a-script-reaches-an-app-through-a-handle-module-written-from-its-site.md) (`epicenter add` writes a handle module), [ADR-0760](0760-global-shortcuts-are-a-capability.md) (Whispering's shortcut becomes a capability).
- **Unbuilt:** all of it: the generator and the `.gitignore` entry for its output; the `package.json` key a capability declares its plugin and platform permissions in; `modules/` in any app; the development host.

## Context

[ADR-0756](0756-an-apps-native-shell-is-linked-from-its-capabilities.md)
made the shell's `main.rs` and Tauri permissions a build output and kept the
rest of `src-tauri/` as it is: `apps/whispering/src-tauri/` still holds
`tauri.conf.json`, `tauri.dev.conf.json`, `Info.plist`, `entitlements.plist`,
an icon, `Cargo.toml`, `build.rs`, and the capability file
`capabilities/whispering.json`, all committed. ADR-0756 left
those bundle settings to be "decided when the build step is written", and
put the Rust no capability covers in `native/`.

Most of what those files say derives from something an app already
declares. The product name and bundle identifier derive from the site
([ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md)). The
microphone permission is there because the app records, which its
`@epicenter/recorder` dependency already says. The icon set derives from
one image.

Expo generates a React Native app's `ios/` and `android/` directories from
`app.json` and each dependency's config plugin on every build, and does not
commit them (continuous native generation). A dependency's native settings
then change with the dependency.

## Decision

**An app's native shell is generated on every build and never committed.**
The generator writes `tauri.conf.json`, `Info.plist`, entitlements, the
Tauri permission files, `main.rs`, and the Cargo project into a directory
`.gitignore` lists, from three sources:

| Source | Gives |
| --- | --- |
| the site | the product name and the bundle identifier ([ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md)) |
| the capabilities in the app's dependencies | each one's Tauri plugin and permissions, and its platform permissions: `@epicenter/recorder` adds the microphone permission |
| `icon.png` | every icon size each platform needs |

**App-specific native code lives in `modules/<name>/`, each shaped like a
capability: TypeScript plus a Rust plugin.** Promoting a module into
`packages/` is a move, not a rewrite. Most apps have no `modules/`.

**An app's layout:**

```txt
<app>/
  contract.ts     what the app's files are; the build publishes it as /contract.json
  app.ts          the capabilities it needs, composed once for every platform (ADR-0754)
  routes/         its screens
  icon.png        the source of every icon the shell needs
  modules/<name>/ native code no capability covers, TypeScript plus Rust; only when needed
```

**Adding a capability is adding its dependency:**
`bun add '@epicenter/<capability>@workspace:*'`. No `epicenter` command
adds a capability, because the workspace pins every package's version and
the generator reads the dependency. `epicenter add` remains the command
that writes a script's handle module
([ADR-0738](0738-a-script-reaches-an-app-through-a-handle-module-written-from-its-site.md)).

**Development may run on a shared host; a release never does.** After the
generator, a development host is built: one prebuilt shell carrying every
capability's plugin, which loads an app's pages so `bun dev:<app>` runs
without a Tauri build. A release build generates and compiles each app's
own shell.

Shipping new pages to an installed shell without a new release is not
decided; it is a candidate for a later record.

## Consequences

- An app's directory holds no `src-tauri/`. Its native permissions are
  exactly what its dependencies declare, and removing a dependency removes
  its permission from the next build.
- Every build pays the generation step, and a clean release build compiles
  the whole Cargo project.
- A setting none of the three sources gives, such as a window's size, has no
  place yet; the first app that needs one decides where it goes.
- A change to Tauri's configuration format or permission names breaks the
  generator for every app at once, as ADR-0756's build step already did for
  `main.rs`.
- The development host grants every capability's permissions to every app
  it runs. A page that calls a capability its `package.json` lacks works in
  development and fails only in its release build.
- Whispering's `modules/` is empty once its global shortcut is a capability
  ([ADR-0760](0760-global-shortcuts-are-a-capability.md)).

## Considered alternatives

- **Commit the generated shell and regenerate it on demand (Expo's bare
  workflow).** Two copies of each setting, and a hand edit to the
  committed one is lost at the next regeneration.
- **Keep bundle settings hand-written beside a generated `main.rs`
  (ADR-0756).** The microphone permission and the identifier are restated
  from the dependency and the site.
- **`native/` as plain Rust.** Promoting it into a capability means writing
  the TypeScript half and the plugin wrapper then.
- **An `epicenter add` for capabilities.** It would edit `package.json` the
  way `bun add` does, and the name already writes a handle module.
- **Every development build compiles the app's own shell.** Each app's
  first `bun dev:<app>` waits on a Rust build.
