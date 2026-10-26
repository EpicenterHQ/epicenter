# @epicenter/svelte

This package makes a Folder mirror reactive in Svelte 5. The Folder reports
what storage last returned or accepted. Each text editor owns a `draft` for
what the person typed until that value's save answers. `<OpenFolder>` owns
opening, refresh on return, and close.

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

`<OpenFolder>` refreshes on focus, visibility, and reconnection. On page hide,
unload, or close, mounted drafts submit their latest text. Browser unload asks
only while a write is in progress. A desktop window close waits for the draft
flush and queued folder writes before destroying the window. The shell owns
application Quit separately.

## Read landed values

`folder.files` and `folder.tables.notes.rows` are tracked getters. `file(path)`
and `row(id)` participate in Svelte tracking when read in a template or
derivation. These values describe the mirror, so a write's returned `Saved`
promise does not resolve until its new value is visible there. `folder.saving`
tracks queued and active writes. The adapter passes `read`, `write`, `update`,
`delete`, and `refresh` through to the Folder.

```svelte
{#each folder.tables.notes.rows as note (note.id)}
  <p>{note.issues === null ? note.fields.title : note.path}</p>
{/each}
<p>{folder.saving ? 'Saving…' : 'Saved'}</p>
```

A missing row is `row(id) === undefined`. An invalid row keeps its path and
issues. A read failure has an `unreadable` issue; call `folder.refresh()` for
a new attempt. To edit exact source, read `folder.file(row.path)?.data` and
check that it is a string.

## Keep typed text in a draft

Create one `draft(source, save)` per mounted editor component. Its `value`
getter shows what the person typed until that save answers, then follows
`source()` again. Its setter and `set(value)` schedule a save after one second
by default. Teardown and page departure flush the latest text. A failed save
keeps the typed value and its error for retry or discard.

```svelte
<script lang="ts">
  import { draft } from '@epicenter/svelte/folder';
  import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
  import { getFolder } from '$lib/folder.js';

  let { id }: { id: string } = $props();
  const folder = getFolder();
  const title = draft(
    () => {
      const row = folder.tables.notes.row(id);
      return row?.issues === null ? row.fields.title : '';
    },
    (value) => folder.tables.notes.update(id, { fields: { title: value } }),
  );
</script>

<input aria-label="Title" bind:value={title.value} />
<UnsavedEdit draft={title} />
```

Use a draft for every text input bound to folder data, including titles and
body editors. Give distinct editor components distinct drafts. A checkbox,
select, or button can write directly; compute toggles from the value shown.
`<UnsavedEdit>` shows the failed save inline with Save again, Discard, and
Copy for text. Direct actions handle their own returned errors near the action.

The package also exports agent conversation bindings and status display
helpers. Those are independent of Folder editing.
