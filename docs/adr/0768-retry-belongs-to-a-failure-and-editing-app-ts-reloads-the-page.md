# 0768. Retry belongs to a failure, and editing `app.ts` reloads the page

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0766](0766-an-apps-capabilities-are-module-values-opened-synchronously.md) at its `app.ts` example and its consequence "an edit to `app.ts` reopens its capabilities, and its `import.meta.hot?.dispose(...)` closes the old ones": no app writes a hot-reload line; [ADR-0767](0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md) at its `folder.state()` and `folder.retry()` lines and at `<Opening>`: the states are `opening`, `open`, `failed` and `closed`, `retry()` is on the failed state, and the root is `<WhenOpen>`.
- **Relates:** [ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) (a change of world is a reload).

## Context

ADR-0767 gave the folder three states (`opening`, `ready`, `failed`) and a
`folder.retry()` beside them that "does nothing otherwise". Two things did
not fit.

`retry()` was a member of every folder that meant something in one state.
Its own documentation had to say when it was inert, and the folder had to
reserve its name against collections.

A disposed folder still said `ready` or `opening`, which was not true of it.

Hot reload needed lines in every app. Todos' first `app.ts` carried an
`import.meta.hot.dispose` that closed the folder and the account. That ran
nothing on an edit, because Vite runs the disposer of the module where an
update is accepted, and the components importing `app.ts` accept their own
updates. It needed `import.meta.hot.accept(() => invalidate())` too: four
lines, and a comment explaining Vite's propagation rules, in every app.

Editing `app.ts` changes what the app is made of. ADR-0754 already says what
happens when a page's world changes: the page reloads.

## Decision

**A folder's state is where it is in its life, and retrying is part of a
failure.**

```ts
type FolderState =
	| { status: 'opening' }
	| { status: 'open' }
	| { status: 'failed'; error: OpenFolderError; retry(): void }
	| { status: 'closed' };
```

A failure's `retry()` opens again only while that failure is still the
state. A retry kept from an earlier failure does nothing. Disposing the folder
moves it to `closed`. The root that reads it is `<WhenOpen>` from
`@epicenter/svelte/when-open`, which renders the pages while the folder is
`open`, and nothing once it is `closed`.

**In development, an edit that reaches `src/lib/app.ts` reloads the page.**
That covers the file itself and anything it imports, such as the contract.
The shared Vite preset (`workspaceAppViteConfig` in `@epicenter/vite-config`)
finds the file by convention and sends a full reload. A reload frees the
old world whole, including its folder, its Worker and every listener, so no
app closes anything by hand. An edit that reaches only components still
updates in place.

```ts
// src/lib/app.ts: no hot-reload lines
export const account = connectAccount();
export const folder = fromClient(openFolder(todos, { site, account }));
```

## Consequences

- The folder has no `retry` member, and `retry` is free as a collection name.
- `closed` is visible to anything that reads `state()`; actions after it
  answer `Unavailable` as before.
- Capabilities still close on `[Symbol.dispose]()`, for tests and for code
  that leaves a route. Apps never call it for hot reload.
- Editing `app.ts` or the contract loses in-memory page state, such as a
  half-typed draft. Those edits are rare, and they change the world the state
  was made in.
- An app whose capabilities live somewhere other than `src/lib/app.ts` gets
  no reload. That file is the convention ADR-0766 fixed for every app.

## Considered alternatives

- **`import.meta.hot.accept(() => invalidate())` and a disposer in each
  app.** It works, at four lines per app that each app must get right.
- **`import.meta.hot.decline()` in each app.** One line, but still a line
  per app, and it relies on how Vite treats a declined module on the way up.
- **Keep `folder.retry()` and add `closed`.** This keeps a member that is
  inert in three of four states.
