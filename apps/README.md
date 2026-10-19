# Apps

Apps open local files through one `@epicenter/folder` handle. A table is a
view of Markdown files in a top-level directory. An app supplies TypeBox
schemas to interpret rows; the schemas do not authorize writes or remove
fields they do not recognize. Other files remain available through
`folder.files`.

```ts
import { Type } from 'typebox';
import { openFolder } from '@epicenter/folder';

const tables = { todos: Type.Object({ title: Type.String(), done: Type.Boolean() }) };
const opened = await openFolder({ tables });
if (opened.error !== null) throw opened.error;
const folder = opened.data;
const rows = await folder.tables.todos.list();
await folder.close();
```

`openFolder({ tables })` opens this browser origin's stable default in
IndexedDB. It requires no account, network connection, Git repository, or
schema file. A native opener receives `{ directory, tables }`: Bun receives an
existing path, while an Epicenter WebView receives a directory scope that the
shell registered and granted to that window. Native files use directory
writes, with the same row parsing and merge rules as the browser.

The previous browser opener stored named folders in OPFS. The new browser
opener checks for that data and refuses to show an empty IndexedDB folder in
its place. It leaves the OPFS data intact. Importing those folders is a
separate step. Existing native directory files remain in their directories;
the new native opener can read and edit them without Git or `epicenter.json`.

## Svelte app root

`<FolderApp>` opens the handle when the route mounts and closes it after
pending work settles. It provides the handle, one TanStack Query cache, row
drafts, local save status, and change invalidation to its children through
`getFolder()`. A failed save keeps its draft. A page may register its own text
drafts and file actions with the context so close waits for them too.

```svelte
<script lang="ts">
	import FolderApp from '@epicenter/svelte/folder-app';
	import { todosTables } from '$lib/definition.js';
	import TodosView from './local/TodosView.svelte';
</script>

<FolderApp title="Todos" tables={todosTables}><TodosView /></FolderApp>
```

An Epicenter WebView's root obtains its handed directory scope before
opening. Neither a browser page nor an app chooses a native path from its
URL. A refused open shows the refusal; the app does not open different
storage as a fallback.

Folder methods return the current source with every row. A view keeps the
source it edited as its save base, listens to `onChange` for affected paths,
and reports "Saved on this device" only after the storage save succeeds and
no draft remains. Account, inference, and future Git exchange have separate
lifetimes. They do not gate local opening or saving.

The root `bun dev:<app>` scripts start each app's required development
processes. See each app's README for its route and test commands. Todos is the
first demonstration of the new browser contract; Capture, Honeycrisp, Vocab,
and Whispering also use the Folder handle. Epicenter owns the Tauri shell and
its folder grants.
