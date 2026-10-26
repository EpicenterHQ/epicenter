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

`<OpenFolder>` refreshes on focus, visibility, and reconnection, and closes
its Folder when it unmounts; each draft inside sends its text as it unmounts.

Leaving asks once, only when the page is unsure, through the web's own
`beforeunload`. A draft sends its latest text and is unsure while that save is
out or failed; `<OpenFolder>` is unsure while a write is out. A browser tab
shows "Leave site?". A desktop window has one guard (`holdWindowClose`) that
asks the same listeners, waits up to three seconds for `folder.idle()`, asks
again, and asks natively whether to close anyway only if the page is still unsure.
The shell owns application Quit separately.

## Read landed values

`folder.files` and `folder.tables.notes.rows` are tracked getters. `file(path)`
and `row(id)` participate in Svelte tracking when read in a template or
derivation. These values describe the mirror, so a write's returned `Saved`
promise does not resolve until its new value is visible there. `folder.saving`
tracks queued and active writes. The adapter passes `read`, `write`, `update`,
`delete`, `refresh`, and `idle` through to the Folder.

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
is queued or active and “On this device” otherwise. An idle folder may still
have text in a draft's debounce, so the calm line makes no saved claim.

## Keep typed text in a draft

Create one `draft(source, save)` per mounted editor component. Its `value`
getter shows what the person typed until that save answers, then follows
`source()` again. Its setter and `set(value)` schedule a save after one second
by default. Teardown, page hide, hidden visibility, and beforeunload flush the
latest unsent text. A value whose save already failed is not resent on
teardown. A failed save keeps the typed value and its error for retry or
discard, and makes a leaving page ask until it is saved or discarded.

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

Call `await editor.land()` before an action needs the typed text on disk. It
cancels the debounce, waits for an out save, and sends any newer typing before
returning. A failure remains on `editor.error` for `<UnsavedEdit>` and is also
returned to stop the action. After teardown, `land()` succeeds without saving.

`fileDraft(folder, path, options?)` from `@epicenter/svelte/folder` edits a
whole text file. It shows LF line endings and, when sending, reads the current
landed file to restore its newline style with `withFileNewlines`. If the file's
data is not text, the draft starts empty and writes LF text. It has the same
`value`, `error`, `set`, `retry`, `discard`, and `land` API as `draft`.

The package also exports agent conversation bindings and status display
helpers. Those are independent of Folder editing.
