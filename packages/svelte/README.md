# @epicenter/svelte

This package makes an app's files reactive in Svelte 5: a contract's client
through `fromClient` (`@epicenter/svelte/client`). The component that shows
a note owns one editor of it (`notes.edit({ id })`), which shows what the
person typed until its save answers.

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

`fromAuth`, `fromAi` and `fromClient` are built on it; `fromClient`, which
lists a collection while it is read, passes that work as its subscribe to
`createTracker`. There is no generic `from(x)`: each adapter names its reads.

## A contract's client

`fromClient(client)` takes any `Client<T>` (`openDevice` or `openRemote`) and
gives each collection tracked `items`, `invalid` (notes), `loading`, `error`
and `get(args)`, plus its writes, which pass the version shown. A collection
lists and subscribes only while an effect reads it, and follows every change
the client hears. A listing that fails keeps what showed, sets `error`, and
is tried again after half a second, doubling to 30 seconds, while anyone
reads. A write puts what landed into what shows before it resolves. A note `update` follows `updateNote`: carried over another
writer's change to other fields, a `Conflict` when they changed the same
one, after which the adapter shows theirs and a second save applies over it.
`notes.edit(args)` is one note as an immediate editor, one save at a time,
made over what the person saw when the typing began. Its `fields` hold one
accessor per field the contract declares (the collection's `fieldNames`) and
`body`, each showing what was typed until its save answers, then the note;
`exists` says whether a note that reads is listed at its path (false while
it is missing, deleted or does not read).

The root, wherever it opens the client (the desktop root, the local web
startup, or the online root), wraps it once and sets one typed context per
collection its components read. Each app declares those pairs with
`createContext` beside the collection's type, and sets them during the
root's setup, never after an `await`:

```ts
// src/lib/todos.ts
export const [getTodos, setTodos] = createContext<ReactiveNotes<TodoNotes>>();

// The root, where the client is made
const files = fromClient(device); // or fromClient(openRemote(todos, { account, site: 'https://todos.epicenter.so' }))
setTodos(files.todos);
```

A list reads the collection from its context:

```svelte
<script lang="ts">
  import { getTodos } from '$lib/todos.js';

  const todos = getTodos(); // ReactiveNotes for that collection
</script>

{#each todos.items as todo (todo.id)}<TodoRow {todo} />{/each}
{#each todos.invalid as file (file.path)}<pre>{file.text}</pre>{/each}
```

The view of one open note makes one editor of it during setup, gates on
`exists`, and reads and binds every value through `fields`, rather than a
second `todos.get({ id })` or a prop:

```svelte
<script lang="ts">
  const todo = getTodos().edit({ id }); // one editor per open note
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
`todos.get({ id })`.

An editor that holds a whole-note draft saves it with
`files.todos.replace({ id }, draft, { over })`, where `over` is the version
the draft began from, so another writer's change since is a `Conflict`
instead of being overwritten; without `over`, `replace` writes over the
version shown.

### One store per page: this browser or the repository

An app's web build has up to two variants, each over one store for the
page's life, and nothing moves between them
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
The local variant's startup opens this browser's files
(`await openDevice(contract)`); it works signed out and offline, and signing
in only adds hosted capabilities. The online variant, under a signed-in
layout, opens the person's repository through the server
(`openRemote(contract, { account, site })`). Either root wraps its client once and
sets the same collection contexts, so the pages never know which store they
read. A page uses one or the other, never both.

### A desktop app's folder

A standalone desktop app opens the folder its shell names from its site,
by name: `~/Epicenter/<label>`, or `~/Epicenter Dev/<label>` in development,
made when nothing is there. `DesktopStartup` opens machine-local AppData
settings when the app has them, then the data folder. A failed open, such as
a link to a drive that is not connected, shows `Recovery` with its error and
Retry. The header shows the folder's path (`displayPath`), which no command
takes. The header reads `getFolderSync()` and checks on focus whether
Epicenter manages the folder.

```svelte
<DesktopStartup app="Capture" contract={capture} site={APPS.CAPTURE.url}>
  {#snippet children(_appData, device, site)}
    <DesktopRoot {device} {site}>…</DesktopRoot>
  {/snippet}
</DesktopStartup>
```

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
