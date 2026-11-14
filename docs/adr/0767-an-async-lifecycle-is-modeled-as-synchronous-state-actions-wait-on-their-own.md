# 0767. An async lifecycle is modeled as synchronous state; actions wait on their own

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Supersedes:** [ADR-0410](0410-an-app-is-returned-ready-and-page-teardown-owns-recovery.md): an asynchronous opener that resolves to a ready App, so no caller holds anything while it opens; a capability is now handed over at once, and the `openApp` and `App` that record described exist nowhere in code.
- **Amends:** [ADR-0766](0766-an-apps-capabilities-are-module-values-opened-synchronously.md) at its consequence "A reader outside `<Opening>` sees the opening state and handles it" and at the action row of the standard shape: a read answers at every moment without checking `state()`, every async method on a folder or its collections waits for the open, and only `<Opening>` and Recovery read `state()`.
- **Amended by:** [ADR-0768](0768-retry-belongs-to-a-failure-and-editing-app-ts-reloads-the-page.md) at `folder.state()`, `folder.retry()` and `<Opening>`: the states are `opening`, `open`, `failed` (carrying `retry()`) and `closed`, and the root is `<WhenOpen>`.
- **Relates:** [ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) (a dependent takes the folder as a value), [ADR-0765](0765-choose-by-value-not-by-name-every-capability-has-the-same-shape.md) (the shape every capability shares).
- **Amended by:** [ADR-0775](0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md) at the folder's states and an action answering the open's error: the state is its lifecycle and whether its store is available, and a write waits through both.
- **Amended by:** [ADR-0777](0777-a-capability-has-no-ready-promise.md) at what a capability exposes of its first load: no `ready` promise; its actions wait.
- **Amended by:** [ADR-0778](0778-a-page-connects-once-and-then-reads-synchronously.md) at a capability loading on its own: a page's stores load in one connection, which `<WhenOpen>` waits for.
- **Unbuilt:** dependents built on the waiting actions, such as Whispering's recovery of unfinished recordings and `createRecorder(folder)`. Built in W2 of the plan in `specs/20261104T160000-one-sync-core-on-every-native-platform.md`, starting with Todos.

## Context

[ADR-0410](0410-an-app-is-returned-ready-and-page-teardown-owns-recovery.md)
chose the opposite of handing something over early:

```ts
const app = await openApp(definition, { account });
```

`openApp` resolved only once everything had opened, so "no caller can
receive an opening App", and there was "no public `ready`". That code is
gone: `openApp` appears in no source outside `docs/` and a fictional skill
example. Today each app's `Startup` (and `DesktopStartup` in
`packages/svelte/src/desktop-startup.svelte`) awaits an opener before it
sets any context, which keeps the same promise by another route.

[ADR-0766](0766-an-apps-capabilities-are-module-values-opened-synchronously.md)
reversed that. `openFolder(contract)` returns at once with `state()`
(`opening`, `ready` or `failed`), `retry()` and `subscribe`, and
`src/lib/app.ts` exports `folder` as a module value. It left open what
every other caller does with a folder that is still opening: "A reader
outside `<Opening>` sees the opening state and handles it." Under that
sentence, every module that imports `folder` checks `state()` or waits on
something before it can use it. Whispering's finishing of cut-off
recordings (`finishCutOffRecordings` in
`programs/whispering/src/lib/folder-recordings.ts`) runs at startup and lists
recordings, so it would be one of them.

The collection adapter already answers reads with a loading flag beside
the items: `fromClient` gives each collection `items`, `loading` and
`error` (`packages/svelte/src/client.svelte.ts`).

The platform has met this problem several times:

| API | State | Actions before it is ready |
| --- | --- | --- |
| `HTMLMediaElement` | `readyState` | `play()` returns a promise that waits until playback can start |
| `document.fonts` | `status` | none; `document.fonts.ready` is a separate promise, which fits because fonts have no actions to wait |
| `WebSocket` | `readyState` | `send()` throws while connecting, so every caller writes its own queue |
| Dexie | `isOpen()` | the first query opens the database, and queries wait for the open |

## Decision

**A capability that takes time to open is handed over at once and
exposes its lifecycle as synchronous state.**

```txt
folder.state()          { status: 'opening' } | { status: 'ready' } | { status: 'failed', error: OpenFolderError }
folder.subscribe(fn)    returns the unsubscribe
folder.retry()          opens again after a failure; does nothing otherwise
```

There is no public `ready()` promise.

**Reads always answer.** A folder's collections can be read at every
moment. While the folder opens, a collection's `items()` is empty and its
`loading()` is true, which is the true answer at that moment. No caller
checks `state()` before reading.

**Actions wait for what they need.** Every async method on a folder or its
collections (create, update, delete, list, edit, and the rest) waits for
the open, then runs.

| When the action is called | The action |
| --- | --- |
| opening | waits for the open, then runs; if the open fails, it fails with the open's typed error |
| ready | runs |
| failed | fails with the open's typed error |
| after `retry()` | waits for the new attempt |

**A dependent never waits explicitly.** `createRecorder(folder)` is
created in `app.ts` beside `folder`, at once; its own async work waits
through the folder's actions. Whispering's recovery of unfinished
recordings lists recordings, and that listing waits for the open.

**Only the interface reads `state()`.** `<Opening>` shows the spinner or
Recovery from it, and Recovery's Retry calls `folder.retry()`. Nothing
else reads the lifecycle.

## Consequences

- `app.ts` stays synchronous: a dependent is a value created beside the
  folder, never a promise.
- Every method on a folder or a collection is either a read that answers
  now or an async action that waits. A synchronous method that needs the
  open to answer has no place on it.
- Each action's error type includes `OpenFolderError`. A caller that
  already handles an action's failure handles a failed open the same way.
- A view outside `<Opening>` shows `loading()` while the folder opens,
  never an empty list presented as "nothing here".
- An action called during a slow open takes as long as the open. A button
  pressed while opening completes late instead of failing.
- The folder holds the current open attempt and the actions waiting on it.
  Actions waiting on an attempt that fails fail with its error; `retry()`
  starts a new attempt for the actions called after it.

## Considered alternatives

- **A public `ready()` promise on every capability.** One more method, and
  every caller that could use it already calls an async action that can
  wait for it. `document.fonts.ready` fits only because fonts have no
  actions.
- **Dependents created only once the folder is ready.** Each dependent
  becomes a promise, and `app.ts` is async again, which is the coloring
  ADR-0766 removed.
- **Actions failing with `NotReady` before the open.** It pushes waiting
  onto every caller, as `WebSocket.send()` throwing while connecting made
  every WebSocket user write a queue.
- **Awaiting the app at the root.** ADR-0766's prototypes measured it: a
  blank screen with top-level await, Retry stuck on a rejected module, and
  context that a `.svelte.ts` module, an event handler or a toast cannot
  reach. ADR-0410's `await openApp(...)` is this shape.
