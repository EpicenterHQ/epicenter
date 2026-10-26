# Apps

Apps open local files through `@epicenter/folder`. A Folder mirrors landed
files; a table reads Markdown rows in a top-level directory through an
app-supplied TypeBox schema. Schemas interpret source and do not authorize
writes or remove unknown fields.

```ts
import { Type } from 'typebox';
import { openFolder } from '@epicenter/folder';

const tables = { todos: Type.Object({ title: Type.String(), done: Type.Boolean() }) };
const opened = await openFolder({ tables });
if (opened.error !== null) throw opened.error;
const folder = opened.data;
const rows = folder.tables.todos.rows();
await folder.close();
```

A browser opens the origin's fixed IndexedDB folder. In a desktop window, the
same call opens the directory the shell bound before creating that window; the
page names no path. Bun uses `openFolder({ directory, tables })` with an existing
path. Opening requires no account, network, Git repository, or schema file.
The older browser OPFS folders are not opened or changed. Existing native
files remain in place.

## Svelte app root

`<OpenFolder>` opens the folder, provides its reactive mirror to the product
root, refreshes on return, and closes it on unmount. The product root installs
that value in an app-owned `createContext<SvelteFolder<typeof tables>>()` pair.
Descendants use the app's typed getter. See the
[Svelte package](../packages/svelte/README.md#open-a-folder-in-an-app).

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

The callback opens only when `<OpenFolder>` mounts or retries. Each build
aliases the bare folder specifier to its browser or desktop entry. A refused
open stays a refusal; it does not choose another store.

`folder.files` and `folder.tables.todos.rows` show landed values. A text editor
uses its own `edit(source, save)` from `@epicenter/svelte/folder`, keeping
what was typed visible until that value's save answers. A failed edit save
stays beside the control through `<UnsavedEdit>`. Direct writes return a
`Saved` result after storage and the mirror agree. Page departure needs no extra send because typing already entered the queue; desktop window close waits for queued writes. Product
workflows and account or inference services keep their own lifetimes.

The root `bun dev:<app>` scripts start each app's required development
processes. Each app README names its route and test commands. Epicenter owns
the Tauri shell and binds each window's folder; standalone Todos binds its own.

## Where each app's folder lives

A native ordinary launch opens a fixed reverse-DNS child of one library,
`~/Epicenter` (`~/Epicenter Dev` in development, or `EPICENTER_FOLDER_DIR`),
creating it when missing and reusing it as it is otherwise. Nothing saves or
selects these locations, and earlier locations are never looked for or moved
(ADR-0672). Any other folder opens explicitly from Epicenter's launcher.
Browser pages open their origin's IndexedDB default instead.

The shell chooses a native window's directory before loading the app. Hosted
apps use Epicenter's picker without implementing selection UI themselves.
Standalone wrappers are not required to offer a picker; Todos uses only its
fixed default. Both contexts keep the same `openFolder({ tables })` page API.

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
opened folder value, installs its providers, and composes the product's
state and interface. Whispering also receives only this folder and assembles
its platform capabilities inside its product constructor.
`<OpenFolder>` owns the folder lifecycle for every product.

Use `Shell` for surrounding layout and `View` for a screen or representation.
Keep a specific tool name such as `FolderEditor` for a window within a larger
application. For the naming rationale, see
[product root component names](../docs/adr/0655-product-root-components-use-the-app-name-and-app-suffix.md).

## Messages and Beeper

[Messages](messages/README.md) uses `<OpenFolder>` for authored drafts and send
recovery state. Conversation history stays in Beeper and is read into memory.
The app starts with fictional demo chats; only an explicit desktop connection
reaches Beeper. Its token stays in the device keychain through the CLI.
