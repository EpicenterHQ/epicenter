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

An app on the file contract (decision 7 of the file-contract design; Todos is
the reference) has two sides. The device is a module singleton, always
there; the person's repository is in context, set by the signed-in boundary,
one per account:

```ts
// apps/todos/src/lib/device.ts
export const device = isDesktop ? openFolderDevice(todos) : openBrowserDevice(todos);
```

```svelte
<!-- apps/todos/src/lib/components/SignedIn.svelte: the signed-in boundary -->
<script lang="ts">
  const { account, children } = $props();
  const repo = setRepo(openRemote(todos, { account })); // `@epicenter/svelte/repo`
  const uploader = startUploading(device, repo);
  onDestroy(() => uploader[Symbol.dispose]());
</script>

{@render children()}
```

```svelte
<!-- apps/todos/src/routes/+page.svelte -->
{#if auth === null || auth.state.status === 'signed-out'}
  <TodosApp signedIn={false} />
{:else}
  {#key auth.state.account}
    <SignedIn account={auth.state.account}><TodosApp signedIn /></SignedIn>
  {/key}
{/if}
```

The app component composes its list directly: signed out,
`fromClient(device).todos`; signed in,
`oneList(fromClient(device).todos, fromClient(getRepo<Todos>()).todos)`,
which routes each write to the copy shown and keeps a note shown while it
moves. Views sort with the app's own order. Views read and write through
`fromClient` state:
tracked `items`, `invalid` (notes that do not read, with their text), and
writes that pass the version shown; `fieldEdit` binds one field to an
immediate editor. See
[Todos](todos/README.md) and the [Svelte package](../packages/svelte/README.md).

Apps not yet on the contract still open their folder with `<OpenFolder>` and
`svelteFolder` from `@epicenter/svelte`.

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
| [Capture](capture/README.md) | browser; on the file contract (`capture`) | none; signs in as `so.epicenter.capture` | `captures` |
| [Honeycrisp](honeycrisp/README.md) | browser, hosted | `so.epicenter.honeycrisp` | `folders`, `notes` |
| [Whispering](whispering/README.md) | browser, hosted | `so.epicenter.whispering` | `recordings`, `transcriptions`, `transformations`, `transformation_runs`, `text_runs`; AI connections in records |
| [Messages](messages/README.md) | local program (`bun run --cwd apps/messages start`) | none: the origin's OPFS | contract `messages`: `drafts`, `attempts` |
| [Vocab](vocab/README.md) | browser only | none: the origin's OPFS, and signed in the `vocab` repository | contract `vocab`: `entries`, `chats`, `messages` |

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

[Messages](messages/README.md) keeps its drafts and send attempts as notes of
its own contract on the device. Conversation history stays in Beeper and is
read into memory. Messages runs as a local program on the computer where
Beeper Desktop runs (`bun run --cwd apps/messages start`): its server answers
the page's Beeper requests through the Epicenter CLI, which keeps the token in
the device keychain. It starts with fictional demo chats, and a page served
any other way shows only those.
