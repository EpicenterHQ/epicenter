# @epicenter/svelte

This package makes an app's files reactive in Svelte 5: its folder, or a
contract's client, through `fromClient` (`@epicenter/svelte/client`), and
the root that waits for the folder to open (`<Opening>`). The component that
shows a note owns one editor of it (`notes.edit({ id })`), which shows what
the person typed until its save answers.

## One helper under every adapter

Every capability reads through explicit methods and notifies through one
`subscribe(listener)` that returns the unsubscribe (ADR-0765). Its Svelte
adapter turns the reads into getters with `trackReads` from
`@epicenter/svelte/tracked`, which subscribes through `createSubscriber` only
while something reads in a tracking context:

```ts
export const fromAi = (ai: Ai) =>
	trackReads(ai.subscribe, { models: ai.models }, { chat: ai.chat });
```

`fromAuth`, `fromAi` and `fromClient` are built on it; `fromClient` passes
each collection's `subscribe`, which lists it while something listens, to
`createTracker`. There is no generic `from(x)`: each adapter names its reads.

## An app's folder

An app opens its folder once and wraps it once, at module scope, in
`src/lib/app.ts`
([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)):

```ts
// src/lib/app.ts
const opened = openFolder(todos, { site: APPS.TODOS.url });
export const folder = fromClient(opened);
if (import.meta.hot) {
  import.meta.hot.dispose(() => opened[Symbol.dispose]());
  import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
```

Vite runs only the disposer of the module an update was accepted at, and
the components importing `app.ts` accept their own updates, so `dispose`
alone never runs on an edit to `app.ts` and leaves the old folder open.
Accepting, then invalidating, runs it and hands the update up as before.

`fromClient(folder)` gives each collection tracked `items`, `invalid`
(notes), `loading`, `error` and `get(args)`, plus its writes, which pass the
version shown, and gives the folder a tracked `state` beside `retry()` and
`reveal`. The reads are the folder's own (`@epicenter/folder`): a collection
lists only while something reads it in a tracking context, and follows
every change the folder hears; a read outside tracking is a snapshot, so the
wrapper works at module scope. While the folder opens a collection is empty
and `loading`, and a write waits for the open, answering the open's typed
error when it fails
([ADR-0767](../../docs/adr/0767-an-async-lifecycle-is-modeled-as-synchronous-state-actions-wait-on-their-own.md)).
A listing that fails keeps what showed, sets `error`, and is tried again
after half a second, doubling to 30 seconds, while anyone reads. A write puts
what landed into what shows before it resolves. A note `update` follows
`updateNote`: carried over another writer's change to other fields, a
`Conflict` when they changed the same one, after which the adapter shows
theirs and a second save applies over it. `fromClient(client)` adapts a
plain client (`openDevice`, `openRemote`) the same way, ready at once.

The root layout renders `<Opening>` from `@epicenter/svelte/opening`, the
only reader of `state`: a spinner while the folder opens, `Recovery` with
the typed error and Retry (`folder.retry()`, and Show in Finder where
`folder.reveal` is not null) when it failed, and the pages once it is ready,
inside one plain `<svelte:boundary>` whose page error never shows the
folder's Recovery.

```svelte
<Opening app="Todos" {folder}>{@render children()}</Opening>
```

`notes.edit(args)` is one note as an immediate editor, one save at a time,
made over what the person saw when the typing began. Its `fields` hold one
accessor per field the contract declares (the collection's `fieldNames`) and
`body`, each showing what was typed until its save answers, then the note;
`exists` says whether a note that reads is listed at its path (false while
it is missing, deleted or does not read). It is the one per-component call:
it stops with the component that made it.

A component imports the folder and reads it:


```svelte
<script lang="ts">
  import { folder } from '$lib/app.js';
</script>

{#each folder.todos.items as todo (todo.id)}<TodoRow {todo} />{/each}
{#each folder.todos.invalid as file (file.path)}<pre>{file.text}</pre>{/each}
```

The view of one open note makes one editor of it during setup, gates on
`exists`, and reads and binds every value through `fields`, rather than a
second `todos.get({ id })` or a prop:

```svelte
<script lang="ts">
  const todo = folder.todos.edit({ id }); // one editor per open note
</script>

{#if todo.exists}
  <Input bind:value={todo.fields.title} />
  <Textarea bind:value={todo.fields.body} />
  <Checkbox bind:checked={todo.fields.done} />
  <UnsavedEdit edit={todo} />
{:else}
  <p>This todo is no longer here.</p>
{/if}
```

`fields` stays live for the editor's life, so a view may take it once
(`const { fields } = todo`). A view that needs the saved note beside what is
typed (its version, or the text a save left on disk) reads it with
`folder.todos.get({ id })`.

An editor that holds a whole-note draft saves it with
`folder.todos.replace({ id }, draft, { over })`, where `over` is the version
the draft began from, so another writer's change since is a `Conflict`
instead of being overwritten; without `over`, `replace` writes over the
version shown.

### Apps that have not moved yet

Capture, Honeycrisp, Messages, Vocab and Whispering still open a client in
a root component (`DesktopStartup` on the desktop, `openDevice` or
`openRemote` on the web), wrap it with `fromClient(client)`, and set one
`createContext` pair per collection for the pages under it. `DesktopStartup`
opens machine-local AppData settings when the app has them, then the data
folder, and shows `Recovery` when either fails. The header reads
`getFolderSync()` and checks on focus whether Epicenter manages the folder.

### Leaving while a save is out

Every write through `fromClient`, and every keystroke in a note's `edit`, is
held for the page's leave guard from the moment it is asked for (a keystroke
counts before its save starts; `todo.saving` says so for one editor). Each
app root installs the guard once:

```svelte
<script lang="ts">
  import { guardLeave } from '@epicenter/svelte/leave-guard';
  import { onMount } from 'svelte';

  onMount(guardLeave);
</script>
```

While a write is out, leaving the page asks "Leave site?": online, a write
can take a while to land. A desktop window does not ask the page and closes
at once; a local write still out then is a small, rare loss. A write made on
a client directly, such as a capture of several files, is held with
`holdLeave(write)`.

## Keep typed text in an edit

A note's editor shows each field the person typed until the save carrying
it answers, then follows the collection again. Saves go one at a time; the
newest carries every field typed since the last that landed, so a title and
a body typed together never clash with each other. An older answer cannot
clear newer typing. Another writer's change to a field not typed is carried
over; their change to a typed field is a `Conflict`, and the typing stays. A
failed save keeps the typed fields (`todo.typed`) and the error while the
editor is mounted; `<UnsavedEdit edit={todo} />` from
`@epicenter/svelte/unsaved-edit` shows it inline with Save again, Discard,
and Copy for the title and body typed.
Code that is not typing, such as a list row's checkbox or a workflow, writes
with `update` and handles its own returned error near the action.

Call `await todo.landed()` when an action needs to know the newest typed
values saved, such as before sending them over a network. A failure remains
on `todo.error` and is also returned to stop the action. After teardown,
`landed()` succeeds without saving.

**Composition.** Files are the only durable authority. A collaboration layer (for example a Yjs document) is a session over text units only, the body, and persists through the client's writes like any editor. Agents may write files directly; their changes reach editors through the client's listeners.

The package also exports status display helpers, independent of file
editing. A conversation's adapter is `fromConversation` in
`@epicenter/ai/svelte`, on the same `trackReads`.
