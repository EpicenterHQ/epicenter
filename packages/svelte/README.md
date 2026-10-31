# @epicenter/svelte

This package makes an app's files reactive in Svelte 5: a contract's client
through `fromClient` (`@epicenter/svelte/client`), and the legacy Folder
mirror through `svelteFolder`. Each text editor owns an `edit` for what the
person typed until that value's save answers. `<OpenFolder>` owns opening a
Folder, refresh on return, and close.

## A contract's client

`fromClient(client)` takes any `Client<T>` (`openDevice` or `openRemote`) and
gives each collection tracked `items`, `invalid` (notes), `loading`, `error`
and `get(args)`, plus its writes, which pass the version shown. A collection
lists and subscribes only while an effect reads it, and follows every change
the client hears. A write puts what landed into what shows before it
resolves. A note `update` follows `updateNote`: carried over another
writer's change to other fields, a `Conflict` when they changed the same
one, after which the adapter shows theirs and a second save applies over it.
`fieldEdit(notes, args, field)` is one field as an immediate editor, one save
at a time, made over what the person saw when the typing began.

```svelte
<script lang="ts">
  import { openDevice } from '@epicenter/folder/browser';
  import { fieldEdit, fromClient } from '@epicenter/svelte/client';

  const files = fromClient(openDevice(todosContract));
  const todo = $derived(files.todos.get({ id }));
  const title = fieldEdit(files.todos, { id }, 'title');
</script>

{#each files.todos.items as todo (todo.id)}<TodoRow {todo} />{/each}
{#each files.todos.invalid as file (file.path)}<pre>{file.text}</pre>{/each}
<Input bind:value={title.value} />
<Checkbox checked={todo?.done} onCheckedChange={(done) => files.todos.update({ id }, { done })} />
```

## Open a folder in an app

```svelte
<script lang="ts">
  import { openFolder } from '@epicenter/folder';
  import OpenFolder from '@epicenter/svelte/open-folder';
  import { todosTables } from '$lib/definition.js';
  import TodosApp from './local/TodosApp.svelte';
</script>

<OpenFolder open={() => openFolder({ tables: todosTables })}>
  {#snippet children(folder)}<TodosApp {folder} />{/snippet}
</OpenFolder>
```

The callback opens a fresh folder on mount and retry. `<OpenFolder>` shows
loading and refusal screens, wraps the result with `svelteFolder`, and closes
it on unmount, including an open that finishes after unmount. Remount the root
to choose another folder. The product root installs the received value in its
own typed `createContext` pair so descendants can call `getFolder()` without
repeating the table type:

```ts
import type { SvelteFolder } from '@epicenter/svelte/folder';
import { createContext } from 'svelte';
import type { todosTables } from './definition.js';

export const [getFolder, setFolder] =
  createContext<SvelteFolder<typeof todosTables>>();
```

`<OpenFolder>` refreshes on focus, visibility, and reconnection, and closes
its Folder when it unmounts. Edits send each value as it is typed.

Leaving asks once, only while a Folder write is out, through the web's own
`beforeunload`. `<OpenFolder>` owns that question. A browser tab shows
"Leave site?". A desktop
window can wait instead: its one guard (`holdWindowClose`) waits for
`folder.idle()` and closes while the page shows "Saving…". Closing again while
it waits asks whether to close anyway. Text whose save failed stays on screen
while the editor is open; leaving discards it without asking.
The shell owns application Quit separately.

## Read landed values

`folder.files` and `folder.tables.notes.rows` are tracked getters. `file(path)`
and `row(id)` participate in Svelte tracking when read in a template or
derivation. These values describe the mirror, so a write's returned `Saved`
promise does not resolve until its new value is visible there. `folder.saving`
tracks queued and active writes. The adapter passes `read`, `write`, `update`,
`replace`, `move`, `delete`, `refresh`, and `idle` through to the Folder.

```svelte
<script lang="ts">
  import { saveLine } from '@epicenter/svelte/status-line';
</script>

{#each folder.tables.notes.rows as note (note.id)}
  <p>{note.issues === null ? note.fields.title : note.path}</p>
{/each}
<p>{saveLine(folder.saving).label}</p>
```

A missing row is `row(id) === undefined`. An invalid row keeps its path and
issues. `<RowIssues issues={row.issues} />` from
`@epicenter/svelte/row-issues` renders the issue sentences; the core also
exports `describeIssue` and `describeIssues`. A read failure has an
`unreadable` issue; call `folder.refresh()` for a new attempt. To edit exact
source, read `folder.file(row.path)?.data` and check that it is a string.
`saveLine` from `@epicenter/svelte/status-line` shows “Saving…” while a write
is queued or active and “On this device” otherwise.

## Keep typed text in an edit

Create one `edit(source, save)` per mounted editor component. `save(value)`
receives each typed value immediately. A retry resends the failed value.
The edit's `value` getter shows what the person typed until that save answers,
then follows `source()` again. Its setter and `set(value)` send each value
immediately.
An older answer cannot clear newer typing. A failed save keeps the typed value
and its error for retry or discard while the editor is mounted.

```svelte
<script lang="ts">
  import { edit } from '@epicenter/svelte/folder';
  import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
  import { getFolder } from '$lib/folder.js';

  let { id }: { id: string } = $props();
  const folder = getFolder();
  const title = edit(
    () => {
      const row = folder.tables.notes.row(id);
      return row?.issues === null ? row.fields.title : '';
    },
    (value) => folder.tables.notes.update(id, { fields: { title: value } }),
  );
</script>

<input aria-label="Title" bind:value={title.value} />
<UnsavedEdit edit={title} />
```

Use an edit for every text input bound to folder data, including titles and
body editors. Give distinct editor components distinct edits. A checkbox,
select, or button can write directly; compute toggles from the value shown.
`<UnsavedEdit>` shows the failed save inline with Save again, Discard, and
Copy for text. Direct actions handle their own returned errors near the action.

Call `await editor.landed()` when an action needs to know the newest typed value
saved successfully, such as before sending it over a network. A failure
remains on `editor.error` for `<UnsavedEdit>` and is also returned to stop the
action. After teardown, `landed()` succeeds without saving.

`fileEdit(folder, path)` from `@epicenter/svelte/folder` edits a
whole text file. It shows LF line endings and sends each value through
`folder.replace(path, data)`, restoring the current file's newline style with
`withFileNewlines`. If the file's data is not text, the edit starts empty and
writes LF text. A deleted file returns `NothingToUpdate`, which the edit shows
inline for Save again, Discard, or Copy. It has the same
`value`, `error`, `set`, `retry`, `discard`, and `landed` API as `edit`.

The later write wins on the same unit: a field, the body, or a whole file.
Field and body updates make up to three checked attempts when storage changes
during a save, then return `KeptChanging` for inline recovery. `write` still
creates or replaces a file, while `create` expects an absent path. A stale
create reply that reads back its own bytes counts as landed; identical existing
bytes are indistinguishable from that case.

**Composition.** Files are the only durable authority. A collaboration layer (for example a Yjs document) is a session over text units only, the body, and persists through Folder instructions like any editor. Fields are never collaborative; they stay last-write-wins per field. No layer writes files except through the Folder. Agents may write files directly or issue the same Folder instructions through Epicenter; either way their changes reach editors through the Folder copy.

The package also exports agent conversation bindings and status display
helpers. Those are independent of Folder editing.
