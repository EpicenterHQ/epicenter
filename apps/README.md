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
folder.close();
```

`openFolder({ tables })` opens this browser origin's stable default in
IndexedDB. It requires no account, network connection, Git repository, or
schema file. In a desktop window the same call opens the one directory the
shell bound to that window before it existed; the page names no path, scope,
or window. Bun receives `{ directory, tables }` with an existing path. Native
files use atomic directory writes with the same row interpretation and whole-file
publication semantics as the browser. One folder-owned editor retains text per
path. Raw and schema-bound views share it. A publication replaces the path;
later publications may overwrite outside changes or recreate a deleted path.
Outside observations never trigger automatic saves.

The previous browser opener stored named folders in OPFS. The new browser
opener uses IndexedDB independently. It does not read, inspect, change, or
remove the OPFS data, so a browser with only older data opens an empty current
folder. Importing those folders is a separate step. Existing native directory
files remain in their directories; the new native opener can read and edit
them without Git or `epicenter.json`.

## Svelte app root

`<FolderApp>` calls the app's opener and provides one UI context. Each app
installs that exact context for descendants to read through `getFolder()`.
Folder owns accepted edits, autosave, save status, and storage closure. The
context connects it to one TanStack Query cache, change invalidation, and window
behavior. Failed saves retain input in Folder. Close synchronously releases listeners and storage without submitting held input
or waiting for writes. Page hide calls best-effort `flush()`. Callers needing
durable bytes await the write or save they started; confirmed departure accepts
losing unfinished work. Apps
refuse new work and late results through their own closing state. Compose a
deliberate workflow from the editor's current content. Unfinished forms remain
with the app. Internal navigation retains the app's Folder; document or window
destruction does not wait for its close.

The editing lifecycle is recorded in [ADR 0656](../docs/adr/0656-a-folder-owns-typed-input-from-open-to-close.md).

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
edit handle (`createFileEdit(folder.tables.todos.edit(id))`) and types over what it showed.
The shared folder context owns query keys and the one `onChange` listener that
refreshes affected paths. The view reports "Saved on this device" only after
the storage save succeeds and no input is held. Account, inference, and future Git exchange have separate
lifetimes. They do not gate local opening or saving.

The root `bun dev:<app>` scripts start each app's required development
processes. See each app's README for its route and test commands. Todos is the
first demonstration of the new browser contract; Capture, Honeycrisp, Vocab,
and Whispering also use the Folder handle. Epicenter owns the Tauri shell and
binds each window's folder; standalone Todos binds its own.

## Where each app's folder lives

A native ordinary launch opens a fixed reverse-DNS child of one library,
`~/Epicenter` (`~/Epicenter Dev` in development, or `EPICENTER_FOLDER_DIR`),
creating it when missing and reusing it as it is otherwise. Nothing saves or
selects these locations, and earlier locations are never looked for or moved
(ADR-0672). Any other folder opens explicitly from Epicenter's launcher.
Browser pages open their origin's IndexedDB default instead.

| App | Surfaces | Native default | Tables |
| --- | --- | --- | --- |
| Epicenter | Settings (host) | `so.epicenter` (records) | `connections`; the folder editor declares none |
| [Todos](todos/README.md) | browser, hosted, standalone native | `so.epicenter.todos` | `todos` |
| [Capture](capture/README.md) | browser, hosted | `so.epicenter.capture` | `captures` |
| [Honeycrisp](honeycrisp/README.md) | browser, hosted | `so.epicenter.honeycrisp` | `folders`, `notes` |
| [Whispering](whispering/README.md) | browser, hosted | `so.epicenter.whispering` | `recordings`, `transcriptions`, `transformations`, `transformation_runs`, `text_runs`; AI connections in records |
| [Messages](messages/README.md) | browser, hosted | `so.epicenter.messages` | `drafts`, `attempts` |
| [Vocab](vocab/README.md) | browser only | none | `entries`, `chats`, `messages` |

Local Books keeps its QuickBooks replica in SQLite under
`<AppData>/apps/so.epicenter.local-books`, outside the library. `api`,
`landing`, and `posthog-reverse-proxy` are infrastructure and open no folder.

## Product root names

Name each product root `<Product>App`: `TodosApp`, `CaptureApp`,
`HoneycrispApp`, `VocabApp`, and `WhisperingApp`. This component receives the
opened folder context, installs its providers, and composes the product's
state and interface. Whispering also receives only this context and assembles
its platform capabilities inside its product constructor.
`FolderApp` owns the folder lifecycle for every product.

Use `Shell` for surrounding layout and `View` for a screen or representation.
Keep a specific tool name such as `FolderEditor` for a window within a larger
application. For the naming rationale, see
[product root component names](../docs/adr/0655-product-root-components-use-the-app-name-and-app-suffix.md).

## Messages and Beeper

[Messages](messages/README.md) uses `FolderApp` for authored drafts and send
recovery state. Conversation history stays in Beeper and is read into memory.
The app starts with fictional demo chats; only an explicit desktop connection
reaches Beeper. Its token stays in the device keychain through the CLI.
