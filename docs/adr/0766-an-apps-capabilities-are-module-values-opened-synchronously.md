# 0766. An app's capabilities are module values, opened synchronously

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0753](0753-an-app-declares-what-it-is-and-what-it-needs-the-platform-supplies-where-how-and-when.md) at "What it needs": the capabilities are module values exported from `src/lib/app.ts`, and where a capability keeps its per-computer state is the platform's answer, which app code never names; [ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) at its `app.ts` example `export const folder = await openFolder(whispering)` and at "A core API reads through explicit methods": `openFolder(contract)` returns at once with readiness as `folder.state()`, a snapshot keeps its identity until something changes, and an action returns a typed result; [ADR-0756](0756-an-apps-native-shell-is-linked-from-its-capabilities.md) at `app.ts` in the app's layout and the composition `epicenter new` writes: the file is `src/lib/app.ts`, exporting each capability and one `import.meta.hot?.dispose(...)`; [ADR-0765](0765-choose-by-value-not-by-name-every-capability-has-the-same-shape.md) at `openAppData` among the openers that "become one `openFolder(contract)`", at "startup owning both roots", at its Svelte part, and at "Code chooses by value": `openFolder` replaces `openDataFolder`, `openDevice` and `openRemote`, no app opens AppData, React adapts through `useSyncExternalStore` beside Svelte's `createSubscriber`, and a choice is a value only where it varies between call sites.
- **Amended by:** [ADR-0767](0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md) at "A reader outside `<Opening>` sees the opening state and handles it" and at the action row of the standard shape: a read answers at every moment without checking `state()`, every async method on a folder or its collections waits for the open, and only `<Opening>` and Recovery read `state()`.
- **Relates:** [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) (the account's copy on the web), [ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md) (where the folder is), [ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md) (the build picks an implementation), [ADR-0760](0760-global-shortcuts-are-a-capability.md) (shortcut overrides), [ADR-0764](0764-reaching-a-model-is-epicenter-ais-alone-in-the-openai-vocabulary.md) (`openAi`, `modelChoices()` and `customEndpoints()`).
- **Unbuilt:** all of it: the synchronous `openFolder(contract)` with `state()`, `retry()` and `subscribe`; `src/lib/app.ts` in any app; `<Opening>` in `@epicenter/svelte`; per-computer state kept by each capability in AppData through the shell; the `test` build condition's in-memory capabilities; the `device` to `folder` renames. Built in W2 of the plan in `specs/20261104T160000-one-sync-core-on-every-native-platform.md`, starting with Todos.

## Context

An app opens its capabilities in a root component and hands them down
through Svelte context. On the desktop, `DesktopStartup`
(`packages/svelte/src/desktop-startup.svelte`) awaits `openAppData` and then
`openDataFolder` under the layout's `<svelte:boundary>` and renders
`Recovery` when either fails. Each app's `Startup`
(`apps/todos/src/lib/components/Startup.svelte`, and the same file in
Capture, Honeycrisp and Vocab; Whispering's `DesktopStartup.svelte`) wraps
the client with `fromClient` and sets one `createContext` pair per
collection its components read (`setTodos`, `getTodos`). Four async openers
each return `Result<Client, OpenDeviceError>`: `openDataFolder` and
`openAppData` (`packages/folder/src/desktop-folder.ts`), `openDevice` (one
each in `packages/folder/src/browser.ts`, `packages/folder/src/tauri.ts`
and `packages/folder/src/node.ts`), and `openRemote`
(`packages/folder/src/remote.ts`).
[ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md)'s
`app.ts` awaited `openFolder`, and
[ADR-0765](0765-choose-by-value-not-by-name-every-capability-has-the-same-shape.md)
merged the openers into `openFolder(contract)` with a startup owning both
roots.

Context reaches only component setup. `getContext` called anywhere else
throws `lifecycle_outside_component`, and a `createContext` getter with no
provider above it throws `missing_context`. A `.svelte.ts` module, an event
handler or a toast cannot reach the folder; a caller passes it in.

Per-computer state sits in three directories on the desktop: the data
folder, `Root::AppData` (`app_data_dir()`, holding Whispering's
`shortcuts.md` and `connections.md`, opened through `openAppData`), and
`app_local_data_dir()`, where transcription keeps
`local-transcription.json` (`packages/transcription/src/lib.rs`).

Two prototype branches tested where an app's values open and how pages read
them, in Todos under `apps/todos/src/routes/proto/`, with probes in
`apps/todos/.proto-probe/` driving the static build and `vite dev` in
Chromium. Branch `claude/proto-app-root` (`b7f11f3e02`) compared six
options: (a) module top-level await, (b) a layout `load`, (c) a boundary
with context, (d) a lazy singleton, (e) a splash in `app.html`, and (f) one
module promise every reader awaits.

| Option | What the probes showed |
| --- | --- |
| (a) top-level await | a blank screen while opening; after a failure Retry stayed stuck on the cached rejected module; hovering a link preloaded the module, which opened the folder |
| (b) layout `load` | any `invalidateAll` reopened the folder |
| (c) boundary with context, as reviewed (`/proto/cr`) | worked, but needed `await untrack(openApp)`, a `Provide` child to set context after the await, and an inner `<svelte:boundary>` so a page crash did not show the open Recovery; Retry rebuilt the whole app and leaked listeners |

Branch `claude/proto-sync-open` (`66618862d9`) built the synchronous
version (`/proto/s`): `openFolder` returns at once, `state()` is opening,
ready or failed, and `<Opening>` gates the pages, with Retry calling
`folder.retry()`. Against (c) as reviewed, its root took about 30 lines
against 55. Its open errors are typed, where a boundary's `failed` snippet
receives `unknown`. `<Opening>` catches nothing, so no page bug can show the
open Recovery. Its test drives every state with a fake folder and
`flushSync` in 14 lines, where the test of (c)'s layout mocked the opener's
module and waited past `flushSync`.

The word `device` names two things in code: about 950 uses mean the synced
folder (`openDevice`, `DeviceStore`, `test.device`, `OpenDeviceError`),
about 600 mean hardware such as a microphone, and about 300 name OAuth
device grants. `local` carries six senses, and AppData names two roots.

## Decision

**Opening is synchronous; readiness is a value.** `openFolder(contract)`
returns at once, already opening:

```txt
folder.state()          { status: 'opening' } | { status: 'ready' } | { status: 'failed', error: OpenFolderError }
folder.retry()          opens again after a failure; does nothing otherwise
folder.subscribe(fn)    returns the unsubscribe
```

It replaces four openers; the build picks the implementation
([ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md)):

| Build | Today | `openFolder(contract)` opens |
| --- | --- | --- |
| web | `openDevice` from `@epicenter/folder/browser` | this browser's storage |
| web, with an account passed | `openRemote` from `@epicenter/folder/remote` | the account's copy ([ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md)) |
| desktop | `openDataFolder` and `openAppData` from `@epicenter/folder/tauri` | the app's folder ([ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md)) |
| Node | `openDevice` from `@epicenter/folder/node` | a path |

Collections are expected to come straight off the folder (`folder.todos`),
each with its own loading state; the Todos step of W2 confirms the shape.

**An app's `src/lib/app.ts` exports its capabilities as module values.**

```ts
// src/lib/app.ts
export const account = connectAccount();
export const folder = openFolder(whispering);
export const ai = openAi([hosted(account), customEndpoints(), localServers(), localSpeech()]);
export const choices = modelChoices();

import.meta.hot?.dispose(() => {
	for (const capability of [choices, ai, folder, account]) capability[Symbol.dispose]();
});
```

There is no `openApp()`, no context and no `App` type. Module scope is a
page's world, fixed for the page's lifetime. Server rendering does not
apply: every app is a single-page app or a Tauri window. A component, a
`.svelte.ts` module, an event handler or a toast imports what it uses from
`$lib/app`.

**The root layout renders `<Opening {folder}>` from `@epicenter/svelte`.**

```txt
opening     a spinner
failed      Recovery, whose Retry calls folder.retry(); only the folder reopens
ready       the pages, inside one plain <svelte:boundary> whose failed snippet shows a page error
```

A page crash shows the page error and never the open Recovery. The boundary
is stable Svelte, not SvelteKit's experimental `handleRenderingErrors`.

**A capability keeps its own per-computer state where the platform puts
it; app code never opens or names that place.**

| State | Kept by | Desktop | Web |
| --- | --- | --- | --- |
| model choices by job | `modelChoices()` | AppData, through the shell | this browser's storage |
| connected endpoints | `customEndpoints()` | AppData, keys in the credential store | this browser's storage |
| shortcut overrides | `@epicenter/shortcut` | AppData | this browser's storage |
| transcription's settings | `@epicenter/transcription` | AppData, moved from `app_local_data_dir()` | none: `localSpeech()` is `null` |

**Under a `test` build condition, each capability resolves to an in-memory
implementation:** `folder` is a memory folder and `account` is signed out.
A test seeds them through their ordinary methods and mocks no module.

**Every capability has the standard external-store shape.**

| Part | Rule | Instance |
| --- | --- | --- |
| snapshot | a synchronous read that returns the same object until something changes | `folder.state()`, `account.current()`, `ai.models()` |
| action | asynchronous, returning a typed result | `ai.transcribe(request)` |
| change | one `subscribe(listener)` that returns the unsubscribe | `folder.subscribe` |

A framework adapter is thin. Svelte adapts through `createSubscriber`,
which works at module level, so a Svelte app may wrap a capability once in
`app.ts`. React adapts through
`useSyncExternalStore(capability.subscribe, () => capability.state())`.
`fromClient` (`packages/svelte/src/client.svelte.ts`) remains the one
adapter that does work per item.

**`device` means hardware only in code, and `local` means only "on this
computer".**

| Today | Becomes |
| --- | --- |
| `openDevice`, `closeDevice` | `openFolder`, the folder's `[Symbol.dispose]()` |
| `DeviceStore` | `FolderStore` |
| `test.device` | `test.folder` |
| `OpenDeviceError` | `OpenFolderError` |

On screen, a folder not yet synced is "On this computer".

**A choice is a value only where it varies between call sites.** A
constant choice passed at every call site is a flag argument; the build
makes it. `modelChoices()` takes no `place`. This refines
[ADR-0765](0765-choose-by-value-not-by-name-every-capability-has-the-same-shape.md)'s
"Code chooses by value".

## Consequences

- Each app's `Startup`, `DesktopStartup`
  (`packages/svelte/src/desktop-startup.svelte`), and its per-collection
  `createContext` pairs (`getTodos`, `getNotes`, `getFolders`,
  `getRecordings`) are deleted; `Startup` leaves `#platform/root`.
- `openAppData` is deleted, and AppData names one root:
  `app_data_dir()`.
- Any module can import `folder` before it is ready. A reader outside
  `<Opening>` sees the opening state and handles it.
- A world lasts as long as the page. Replacing it is a reload, as the online
  web already does on a change of account
  ([ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md)).
- In development, an edit to `app.ts` reopens its capabilities, and its
  `import.meta.hot?.dispose(...)` closes the old ones. An app that forgets
  that line leaves a folder open per edit.
- An app that wants server rendering needs a different root; none does.
- Every capability ships an in-memory implementation behind the `test`
  condition, or a test that imports it cannot run.
- The renames touch about 950 sites in one pass.

## Considered alternatives

- **The awaited `openApp()` with one context (`/proto/cr`).** It needed
  `untrack`, a `Provide` child and an inner boundary; Retry rebuilt every
  capability and leaked listeners; its layout test mocked the opener's
  module; and context does not reach a `.svelte.ts` module, an event
  handler or a toast.
- **Module top-level await (`/proto/a`).** A blank screen while opening,
  Retry stuck on the cached rejected module, and a hover preload that
  opened the folder.
- **A layout `load` (`/proto/b`).** Any `invalidateAll` reopened the folder.
- **A lazy memoized getter (`/proto/d`).** Its bindings are `undefined`
  until the open resolves, whatever their type says, and every reader
  awaits it first.
- **SvelteKit's `handleRenderingErrors` with a `+error.svelte`
  (`/proto/ck`) in place of the plain boundary.** It is experimental.
- **`modelChoices({ place: 'local' })`.** Every app passes the same value,
  so the argument is a flag that the build already decides.
