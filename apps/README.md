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
schema file. In a desktop window the same call opens the one directory the
shell bound to that window before it existed; the page names no path, scope,
or window. Bun receives `{ directory, tables }` with an existing path. Native
files use directory writes, with the same row parsing and merge rules as the
browser.

The previous browser opener stored named folders in OPFS. The new browser
opener uses IndexedDB independently. It does not read, inspect, change, or
remove the OPFS data, so a browser with only older data opens an empty current
folder. Importing those folders is a separate step. Existing native directory
files remain in their directories; the new native opener can read and edit
them without Git or `epicenter.json`.

## Svelte app root

`<FolderApp>` calls the app's opener when the route mounts and closes the handle after
pending work settles. It provides the handle, one TanStack Query cache, local
save status, and change invalidation to its children through `getFolder()`.
The folder handle itself holds typed input from open to close
(`folder.tables.<t>.edit(id)`, `folder.files.edit(path)`; see
[ADR-0656](../docs/adr/0656-a-folder-owns-typed-input-from-open-to-close.md)),
and a failed save keeps it. A page counts its file actions with
`context.run` so close waits for them too.

```svelte
<script lang="ts">
	import { openFolder } from '@epicenter/folder';
	import FolderApp from '@epicenter/svelte/folder-app';
	import { todosTables } from '$lib/definition.js';
	import TodosApp from './local/TodosApp.svelte';
</script>

<FolderApp open={() => openFolder({ tables: todosTables })}>
	{#snippet children(context)}<TodosApp {context} />{/snippet}
</FolderApp>
```

The inline callback opens nothing until called. `FolderApp` invokes it on
mount and retry, handles loading and refusal, and owns the returned handle's
lifetime. App code supplies the construction options; the shared root takes
no title or table definitions.

Each app declares its typed `getFolder`/`setFolder` pair with Svelte's
`createContext<FolderContext<typeof tables>>()`. Its root view receives the
opened context and installs it during initialization. Descendants import the
app's getter without supplying a table type. See the
[Svelte package](../packages/svelte/README.md#folder-app-root).

Each build's exact alias of `@epicenter/folder` gives the root one engine. A
desktop window's root opens the directory its shell bound to the window; to
edit another folder, the shell opens another window. Neither a browser page
nor an app chooses a native path, and no URL carries one. A refused open
shows the refusal; the app does not open different storage as a fallback.

Folder methods return the current source with every row. A view binds its own
edit handle (`createRowEdit`, `createTextEdit`) and types over what it showed.
The shared folder context owns query keys and the one `onChange` listener that
refreshes affected paths. The view reports "Saved on this device" only after
the storage save succeeds and no input is held. Account, inference, and future Git exchange have separate
lifetimes. They do not gate local opening or saving.

The root `bun dev:<app>` scripts start each app's required development
processes. See each app's README for its route and test commands. Todos is the
first demonstration of the new browser contract; Capture, Honeycrisp, Vocab,
and Whispering also use the Folder handle. Epicenter owns the Tauri shell and
binds each window's folder; standalone Todos binds its own.

## Product root names

Name each product root `<Product>App`: `TodosApp`, `CaptureApp`,
`HoneycrispApp`, `VocabApp`, and `WhisperingApp`. This component receives the
opened folder context or session, installs its providers, and composes the
product's state and interface. `FolderApp` owns the shared folder lifecycle;
Whispering's layout owns its session lifecycle.

Use `Shell` for surrounding layout and `View` for a screen or representation.
Keep a specific tool name such as `FolderEditor` for a window within a larger
application. For the naming rationale, see
[product root component names](../docs/adr/0655-product-root-components-use-the-app-name-and-app-suffix.md).
