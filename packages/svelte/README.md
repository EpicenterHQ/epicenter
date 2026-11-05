# @epicenter/svelte

This package reads Epicenter's capabilities in Svelte 5: any capability
through one adapter, `reactive` (`@epicenter/svelte/reactive`), and the
folder through the root that renders the pages when it is open
(`<WhenOpen>`). It also holds the folder's shared interface: Recovery, a
note's repair as text (`<NoteRepair>`), and the status display.

## One adapter for every capability

Everything a capability does is one of four verbs, and each answers in its
own form
([ADR-0769](../../docs/adr/0769-svelte-reads-every-capability-through-one-reactive-copy.md)):

| Verb | What it answers | Instance |
| --- | --- | --- |
| create | a capability with its own `subscribe`, at once | `folder.todos`, `todos.edit({ id })` |
| read | a value, at once, the same until `subscribe` fires | `items()`, `state()`, `saving()` |
| act | a promise (or an async iterable) | `create(value)`, `reveal()`, `ai.chat(request)` |
| listen | the unsubscribe | `subscribe(listener)` |

`reactive(capability)` answers a copy of the capability with its own type,
made once from its members. A read tracks the nearest `subscribe` through
`createSubscriber`, so a capability is followed only while something reads
it in a template, `$derived` or an effect, and a read anywhere else is a
snapshot. An action passes through untracked, even when an effect calls it.
A capability it holds or makes is adapted with its own `subscribe`. What a
read answers passes through at its own identity.

The folder, an auth client, `openAi` and a conversation all go through it.
No capability has a Svelte export of its own.

React reads the same capability with no adapter:
`useSyncExternalStore(folder.todos.subscribe, folder.todos.items)`.

## An app's folder

An app opens its folder once and adapts it once, at module scope, in
`src/lib/app.ts`
([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)).
In development, an edit that reaches that file reloads the page
([ADR-0768](../../docs/adr/0768-retry-belongs-to-a-failure-and-editing-app-ts-reloads-the-page.md)),
so it holds no hot-reload lines:

```ts
// src/lib/app.ts
export const folder = reactive(openFolder(todos, home({ site: APPS.TODOS.url })));
```

Each collection reads `items()`, `invalid()` (notes), `loading()` and
`get(args)`, the entry shown, and writes with `set` and `delete`, which
answer once they land and never fail
([ADR-0774](../../docs/adr/0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md),
[ADR-0775](../../docs/adr/0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md)).
The folder reads `state()`, `unavailable()` and `saving()`, and has
`reveal`. The reads are the folder's own (`@epicenter/folder`): a
collection lists only while something reads it, and follows every change
the folder hears. While the folder opens, a collection is empty and
`loading()`, and a write waits for the open
([ADR-0767](../../docs/adr/0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md)).

The root layout renders `<WhenOpen>` from `@epicenter/svelte/when-open`, the
only reader of `state()`. It shows a spinner while the folder opens, with
why the store cannot be reached when `unavailable()` says so, and
`Recovery` with the typed error when it failed. While the folder is open
and its store cannot be reached, a status line says so, and whether
changes are waiting for it. Recovery offers Retry (the
failed state's `retry()`) and Show in Finder where `folder.reveal` is not
null. Once the folder is open it shows the pages, and once it is closed it
shows nothing. The pages sit inside one plain `<svelte:boundary>`, whose page
error never shows the folder's Recovery.

```svelte
<WhenOpen app="Todos" {folder}>{@render children()}</WhenOpen>
```

`<WhenOpen>` also renders the page's leave guard, `<LeaveGuard {folder} />`
from `@epicenter/svelte/leave-guard`. While `folder.saving()`, from a
write's call or an editor's keystroke until it lands, leaving the page
asks "Leave site?". Writes waiting for an unreachable store live only in the
page's memory, so this is what keeps them. A desktop window does not ask the page and closes at
once, so a local write still out then is a small, rare loss.

A component imports the folder and reads it:

```svelte
<script lang="ts">
  import { folder } from '$lib/app.js';
</script>

{#each folder.todos.items() as todo (todo.id)}<TodoRow {todo} />{/each}
{#each folder.todos.invalid() as file (file.path)}<pre>{file.text}</pre>{/each}
```

The view of one open note makes one editor of it, gates on `exists()`, and
reads and binds every value through `fields`, rather than a second
`todos.get({ id })` or a prop:

```svelte
<script lang="ts">
  const todo = folder.todos.edit({ id }); // one editor per open note
</script>

{#if todo.exists()}
  <Input bind:value={todo.fields.title} />
  <Textarea bind:value={todo.fields.body} />
  <Checkbox bind:checked={todo.fields.done} />
{:else}
  <p>This todo is no longer here.</p>
{/if}
```

An editor holds nothing while nobody reads it and needs no teardown; typing
into one whose component is gone still saves. A view that needs the saved
note beside what is typed reads it with `folder.todos.get({ id })`.

An editor of the whole note binds `todo.text`: its front matter and body as
one text. Setting it saves it, settled with any change made since the
typing began; a text whose front matter does not parse is saved as typed
and the note shows in `invalid()`. `<NoteRepair>` from
`@epicenter/svelte/note-repair` repairs such a note through it:

```svelte
<NoteRepair contract={todos} note={invalid} edit={folder.todos.edit({ id })} />
```

## Keep typed text in an edit

A note's editor shows each field the person typed until the save carrying
it lands, then follows the collection again. Saves go through the folder's
queue one at a time; the newest carries everything typed since the last
that landed, so a title and a body typed together never clash with each
other. A typed field takes this write; another writer's change to a field
not typed stays, and a body changed elsewhere since the typing began merges
by lines. A save never fails: while the store cannot be reached it waits,
and the typed fields stay shown (`todo.typed()`). Code that is not typing,
such as a list row's checkbox or a workflow, writes with
`folder.todos.set(args, changes)`.

Call `await todo.landed()` when an action needs the newest typed values
saved, such as before sending them over a network.

**Composition.** Files are the only durable authority. A collaboration layer (for example a Yjs document) is a session over text units only, the body, and persists through the folder's writes like any editor. Agents may write files directly; their changes reach editors through the folder's listeners.

The package also exports status display helpers, independent of file
editing.
