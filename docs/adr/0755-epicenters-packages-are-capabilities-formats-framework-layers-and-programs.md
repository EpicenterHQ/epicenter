# 0755. Epicenter's packages are capabilities, formats, framework layers and programs

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0701](0701-apps-run-as-separate-programs.md) at `desktopVariant()` turning on the `tauri` condition "for the app's `#platform/*` seams" and at the shared `epicenter-standalone` crate: the condition also selects each capability package's leaf, `#platform/*` remains only for app-owned native features and the web sign-in callback, and `epicenter-standalone` merges into `tauri-plugin-epicenter`; [ADR-0403](0403-the-package-selects-its-platform-leaves-at-runtime-and-a-consumers-build-passes-no-condition.md) at "The package selects its default services from the running environment" and at a consumer's build passing no condition: a capability's leaf is selected at build time by the `tauri` export condition.
- **Amended by:** [ADR-0760](0760-global-shortcuts-are-a-capability.md) at its capability list and at "Whispering's global shortcut is an app-owned native feature": `shortcut` is a capability.
- **Relates:** [ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) (what a capability is), [ADR-0751](0751-every-native-app-carries-one-sync-core.md) (`epicenter-core` and `tauri-plugin-epicenter`), [ADR-0756](0756-an-apps-native-shell-is-linked-from-its-capabilities.md) (the shell linked from capabilities), [ADR-0753](0753-an-app-declares-what-it-is-and-what-it-needs-the-platform-supplies-where-how-and-when.md) (the platform supplies how).
- **Unbuilt:** every move below, which branch `claude/package-moves` is making; the `.` export with `tauri` and `default` leaves on each capability; `./svelte` on every capability but `account`.

## Context

`packages/` holds 22 directories: `agent`, `agent-protocol`, `ai`, `auth`,
`capture`, `cli`, `client`, `constants`, `definition`,
`epicenter-transcription-build`, `folder`, `principal`, `recorder`,
`server`, `svelte`, `tauri-epicenter-account`, `tauri-epicenter-standalone`,
`tauri-plugin-epicenter-folder`, `tauri-plugin-epicenter-recorder`,
`tauri-plugin-epicenter-transcription`, `ui`, and `vite-config`. One
capability is split across three of them: the agent loop is in `agent`, the
type contract it shares with the model client is in `agent-protocol`, and
the model client is in `client`. `constants` holds site names, providers,
ports, and routes for four different owners. A desktop shell is three Rust
crates. Only transcription keeps its TypeScript (`guest-js`,
`@epicenter/transcription-native`) and its Rust plugin in one directory.

An app picks a package's platform code itself. `@epicenter/folder` exports
`./browser`, `./tauri`, `./bun`, `./node`, and `./remote`, and no `.`.
Whispering maps four `#platform/*` seams in its `package.json` "imports",
each to a `tauri` and a `default` leaf, and `desktopVariant()`
(`packages/vite-config/src/index.ts`) turns on the `tauri` condition when
`EPICENTER_DESKTOP=1`.

Three seats (one Codex, two Claude) audited the packages by kind, callers,
and caller code. The founder accepted the experience seat's map.

## Decision

**Every Epicenter package is a capability, a format, a framework layer, or
a program.**

| Package | Kind | One sentence |
| --- | --- | --- |
| `folder` | capability | open an app's folder as its contract's client, and this device's place |
| `account` | capability | this app's credentials: its Epicenter sign-in and the person's provider keys |
| `recorder` | capability | recordings written into the folder as they record |
| `ai` | capability | requests to a model the person chose, and the agent loop |
| `transcription` | capability | models on this computer (`null` in a browser) |
| `definition` | format | what an app's files are, how two versions settle, and the names its site derives |
| `svelte` | framework layer | contract reactivity, startup and recovery, status |
| `ui` | framework layer | components |
| `vite-config` | framework layer | the base config and the desktop condition |
| `cli` | program | the `epicenter` command |
| `server` | program | the API |

```txt
epicenter-core                          the sync core (ADR-0751)
tauri-plugin-epicenter                  the shell's commands, credentials, and sync moments, for folder and account
tauri-plugin-epicenter-recorder         recorder's plugin, in recorder's directory
tauri-plugin-epicenter-transcription    transcription's plugin, in transcription's directory;
  epicenter-transcription-build           its build helper, as a sub-crate
```

**The moves:**

| Today | Becomes | Why |
| --- | --- | --- |
| `agent`, `agent-protocol`, `client` | merged into `ai` | the protocol is the type contract the loop and the model client share; inside one package it needs no package |
| `auth`, `principal` | `account` | renamed for what it holds; `principal` merges in |
| `capture` | moved into `apps/capture` | one app uses it |
| `constants` | split by owner | site names into `definition`, providers into `ai`, ports into `vite-config`, routes into `server` |
| `tauri-epicenter-account`, `tauri-epicenter-standalone`, `tauri-plugin-epicenter-folder` | `tauri-plugin-epicenter` | one desktop shell crate |
| startup and chrome components copied into each app | `svelte` | one copy |

**A capability keeps its TypeScript and its Rust plugin in one directory,
and may export `./svelte`.** `./svelte` holds the capability's Svelte
adapter (`fromAi`,
[ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md))
and its own settings UI, as `@epicenter/auth/svelte` holds `fromAuth` today.

**The build picks a capability's leaf by the `tauri` export condition.** A
capability's `.` export lists `tauri` first and the web leaf as `default`,
as `@epicenter/folder`'s would:

```json
"exports": {
  ".": { "tauri": "./src/tauri.ts", "default": "./src/browser.ts" },
  "./tauri": "./src/tauri.ts",
  "./browser": "./src/browser.ts"
}
```

- **The web leaf is `default`, not `browser`.** `desktopVariant()` keeps
  Vite's `browser` condition in the desktop build, so `browser` does not
  tell the two builds apart.
- **`./tauri` and `./browser` stay** for tests and for shared code that
  needs one side, such as Vocab's dictation.
- **An intermediate package takes capabilities as values**, so its own
  typecheck covers one leaf and never resolves a condition.

**`#platform/*` remains only for app-owned native features and the web
sign-in callback.** Whispering's global shortcut is an app-owned native
feature; a seam that chooses between a capability's desktop and web code
becomes that capability's `.` export.

## Consequences

- 22 directories become 11 TypeScript packages and 4 Rust crates, plus the
  transcription build helper.
- Every import of `@epicenter/auth`, `@epicenter/agent`,
  `@epicenter/agent-protocol`, `@epicenter/client`, `@epicenter/principal`,
  and `@epicenter/constants` changes in the same wave, and
  `@epicenter/constants` is deleted.
- An app imports `@epicenter/folder`, not `@epicenter/folder/tauri`, and its
  "imports" map loses every seam a capability now owns.
- A web bundle carries no capability's Tauri leaf, and a desktop bundle
  carries no web leaf. Both leaves never ship in one bundle, so a page cannot
  choose between them at run time.
- A capability's settings UI ships with the capability, so an app adds
  `ai`'s settings without copying them.
- Each new package is checked against the four kinds. A package that fits
  none is a part of one that does.

## Considered alternatives

- **Runtime selection by `isTauri()` inside the package
  ([ADR-0403](0403-the-package-selects-its-platform-leaves-at-runtime-and-a-consumers-build-passes-no-condition.md)).**
  Both leaves ship in every bundle, and the web bundle carries Tauri
  imports.
- **A `#platform/*` seam in each app for each capability (today).** Every
  app repeats the same seam for the same package.
- **`browser` as the web leaf's key.** The desktop build keeps Vite's
  `browser` condition, so the key does not separate the builds.
- **A package per platform (`folder-tauri`, `folder-web`).** Twice the
  packages, and each app chooses again.
- **Keep `agent`, `agent-protocol`, and `client` apart.** Three packages
  for one capability whose only shared surface is a type contract.
