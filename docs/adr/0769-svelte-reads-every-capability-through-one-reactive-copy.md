# 0769. Svelte reads every capability through one reactive copy

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0765](0765-choose-by-value-not-by-name-every-capability-has-the-same-shape.md) at the Svelte part of the six-part shape ("an optional `./svelte` export, `fromX`, built on one shared internal helper") and at the rejected "reactive Proxy, or one generic `from(x)` for every adapter": no capability has a Svelte export, and one generic adapter reads them all; [ADR-0766](0766-an-apps-capabilities-are-module-values-opened-synchronously.md) at the action row of the standard shape and at "`fromClient` remains the one adapter that does work per item": every action answers a promise, a capability a method makes is the shape's fourth form, and the work `fromClient` did belongs to the folder.
- **Relates:** [ADR-0767](0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md) (reads answer at every moment, actions wait), [ADR-0768](0768-retry-belongs-to-a-failure-and-editing-app-ts-reloads-the-page.md) (a failure's `retry()`).
- **Amended by:** [ADR-0774](0774-a-write-that-meets-a-change-settles-it-the-way-sync-does.md) at writes "made over the version shown": the folder settles a write that meets a change, the way sync does.

## Context

ADR-0765 gave every capability the same shape and a Svelte adapter each:
`fromAuth`, `fromAi`, `fromConversation`, and `fromClient` for a folder,
each built on `trackReads`. Each adapter renamed the capability's reads into
getters (`auth.state` for `getState()`, `files.todos.items` for `items()`),
so each needed its own type, and a getter cannot say which reads it makes.

`fromClient` was about 600 lines, and only one of its four jobs was
Svelte's. The others were writing over the version a person saw, the note
editor, and the page's leave guard (`holdLeave`, a global count of writes).
ADR-0765 rejected one generic adapter because `fromClient` did that
per-item work.

A prototype moved the three jobs into the folder: its writes are made over
the version shown, `notes.edit(args)` is a plain editor with its own
`subscribe`, and `folder.saving()` says whether a write is out. What was
left for Svelte was the same for every capability: track a synchronous read
against the capability's `subscribe`. One adapter did that for Todos'
folder and for stand-ins shaped like an auth client, `openAi` and a
conversation, under one set of tests.

One case looked like a read and was not. `ai.refresh()` answered nothing,
so `$effect(() => ai.refresh())` subscribed the effect to `ai`, and each
change ran it again.

## Decision

**Everything a capability does is one of four verbs, and each answers in its
own form.**

| Verb | What it does | What it answers | Instance |
| --- | --- | --- | --- |
| create | makes a smaller capability | that capability, at once, with its own `subscribe` | `folder.todos`, `todos.edit({ id })` |
| read | says what the capability holds now, changing nothing | a value, at once, the same value until `subscribe` fires | `items()`, `state()`, `saving()` |
| act | changes something, or reaches outside the page | a promise (or an async iterable), usually of a `Result` | `create(value)`, `reveal()`, `ai.chat(request)` |
| listen | asks to hear when a read would answer differently | the unsubscribe | `subscribe(listener)` |

Every action answers a promise, including one that could finish at once: a
failure's `retry()`, the editor's `retry()` and `discard()`, `ai.refresh()`
and an endpoint's `refresh()`, a conversation's `stop()` and `retry()`.
Each answers when its work is done. Two members sit outside the verbs: an
editor field's setter (`edit.fields.title = 'Milk'`), an assignment whose
save `landed()` answers, and `[Symbol.dispose]()`, which the language makes
synchronous.

The auth client's read is `state()`, as the folder's is; `getState()` is
gone.

**Svelte reads any capability through `reactive(capability)` from
`@epicenter/svelte/reactive`.** It answers a copy with the capability's own
type, made once from the capability's own members:

- A method whose answer is not a promise or an async iterable is a read,
  and tracks the nearest `subscribe` through `createSubscriber`. An
  accessor's get is a read too.
- An action passes through untracked, even when an effect calls it.
- A capability held or returned is adapted with its own `subscribe`, once
  per object. A plain object held without one (an editor's `fields`) uses
  its holder's.
- What a read answers passes through at its own identity, and so do
  `subscribe` and symbol-keyed members.

```ts
// src/lib/app.ts
export const folder = reactive(openFolder(todos, { site, account }));
```

```svelte
{#each folder.todos.items() as todo (todo.id)}…{/each}
```

React reads the same capability with no adapter:
`useSyncExternalStore(folder.todos.subscribe, folder.todos.items)`.

**The folder does its own writing work.** Its writes are made over the
version shown, its note editor is `edit(args)`, and `saving()` counts its
writes for the leave guard `<WhenOpen>` installs. A file collection reads a
file's bytes with `read(args)`.

## Consequences

- `fromClient`, `fromAuth`, `fromAi`, `fromConversation`, `trackReads` and
  `holdLeave` are deleted, with the `@epicenter/svelte/client`, `/tracked`,
  `/leave-guard`, `@epicenter/account/svelte` and `@epicenter/ai/svelte`
  exports. `@epicenter/account` no longer depends on Svelte.
- A new capability needs no Svelte code. It is checked against the four
  verbs instead.
- The rule that tells a read from an action is the answer's form, so an
  action that answers synchronously would track as a read. The shape rules
  that out.
- An app that opens its own client reads it as `reactive(folderOf(client))`
  until it moves to `openFolder` in `app.ts`.
- The copy holds the members the capability had when it was adapted. A
  capability is a plain object its factory made whole, so a member added
  later is not one the shape allows.
- Typing into an editor whose component is gone still saves; the editor no
  longer stops with its component.
- One typed keystroke into an open todo among 1,000 took 0.078 ms instead
  of 0.058 ms: the editor's one `subscribe` is coarser than `$state` per
  field. A save reaching the list took about 37 ms in both.

## Considered alternatives

- **An adapter per capability (ADR-0765).** Five adapters, each renaming
  reads into getters with its own type, and the folder's writing work
  inside the Svelte one.
- **A Proxy.** It reads members at each access, so it works for members
  added later, but no capability has those; every access went through a
  trap, and the adapted value did not look like an object in a debugger.
- **Capabilities that call an injected `track()` in each read.** No
  adapter at all, but every read carries a duty, and one that forgets it
  goes stale without an error.
- **`untrack` around a synchronous action.** Every caller would need to
  know which actions answer at once.
- **Getters (`items`) instead of read methods (`items()`).** A getter
  cannot take arguments, so `get(args)` would differ from `items`, and
  React's `useSyncExternalStore` takes a function.
