# @epicenter/svelte

This package makes a Folder mirror reactive in Svelte 5, and edits a
repository file's source. The Folder reports
what storage last returned or accepted. Each text editor owns a `edit` for
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

## Edit a repository file's source

`<SourceEditor>` from `@epicenter/svelte/source-editor` edits any synced
Markdown file in an `@epicenter/repository` repository as its whole text,
frontmatter included, in CodeMirror. It holds the file open through
`repo.files.open(path)` and saves as the person types. Key it by the path.

```svelte
<script lang="ts">
  import SourceEditor from '@epicenter/svelte/source-editor';
</script>

{#key path}
  <SourceEditor {repo} {path} lens="notes" />
{/key}
```

Its status line says, for the text on screen, whether the frontmatter parses
(and the line where it breaks) and, given `lens`, whether the note matches
that name's schema, with each issue. Every keystroke is saved on the device.
No synced file ever goes from parsing to not parsing, so a text that would
break frontmatter that parses is saved on the device and held, not sent,
and the status says "Saved on this device; waiting for the frontmatter to
parse" until it parses again. The repository keeps held text through
changes from elsewhere and sends it as soon as it parses. A file whose
frontmatter does not parse saves every step of its repair. A save the
repository refuses, for its size, its bytes or its path, shows its error and
stays in the editor, unsent until the text changes.

`@epicenter/svelte/codemirror` exports the editor behind it,
`createSourceEditor`, and the binding it shares with editors an app composes
itself: `textBinding` writes each local change, and `applyExternal` shows a
change from elsewhere as the smallest edits, kept out of the undo history.

The package also exports agent conversation bindings and status display
helpers. Those are independent of Folder editing.
