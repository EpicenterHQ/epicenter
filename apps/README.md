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

An app on the file contract has up to three variants, each with one store
for its life, and builds only the ones it needs: desktop (the Tauri
window's folder), local web (this browser's files), and online web (the
person's repository, behind sign-in). Nothing moves between stores; signing
in grants capabilities, never storage
([ADR-0700](../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).

| App | Variants |
| --- | --- |
| Todos | online web, desktop |
| Capture, Honeycrisp | online web |
| Vocab | online web, desktop |
| Whispering, Messages | local web |
| Recorder demo | local web (`/`) and online web (`/online`) |

Only a variant's root decides the store. A local or desktop root uses the
device, a module singleton; an online root is the signed-in layout, which
sets the repository in context per account:

```ts
// apps/todos/src/lib/device.ts: the desktop variant's store
export const device = openDevice(todos); // `@epicenter/folder/tauri`
```

```svelte
<!-- apps/todos/src/routes/(app)/+layout.svelte: the signed-in layout (not the sign-in callback) -->
{#if auth.state.status !== 'signed-out'}
  {#key auth.state.account}
    <Online account={auth.state.account}>{@render children()}</Online>
  {/key}
{:else}
  <!-- ask for a sign-in -->
{/if}
```

```svelte
<!-- apps/todos/src/lib/components/Online.svelte -->
<script lang="ts">
  const { account, children } = $props();
  setRepo(fromClient(openRemote(todos, { account }))); // wrapped once, where it is made
</script>

{@render children()}
```

```svelte
<!-- apps/todos/src/routes/(app)/+page.svelte -->
<TodosApp variant="online" todos={getRepo<Todos>().todos} />
```

UI components take the client, or its `fromClient` collection, as a prop,
so a new variant is a new root over the same components. They sort with the
app's own order, and read and write through `fromClient` state: tracked
`items`, `invalid` (notes that do not read, with their text), and writes
that pass the version shown; `fieldEdit` binds one field to an immediate
editor. See [Todos](todos/README.md) and the
[Svelte package](../packages/svelte/README.md).

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
| [Todos](todos/README.md) | online web; desktop (standalone native) | `so.epicenter.todos` | contract `todos`: `todos` |
| [Capture](capture/README.md) | online web | none: the `capture` repository | contract `capture`: `captures` |
| [Honeycrisp](honeycrisp/README.md) | online web | none: the `honeycrisp` repository | contract `honeycrisp`: `notes`, `folders` |
| [Whispering](whispering/README.md) | local web | none: the origin's OPFS | contract `whispering`: `recordings`, `audio`, `transcriptions`, `transformations`, `transformation_runs`, `text_runs` |
| [Messages](messages/README.md) | local program (`bun run --cwd apps/messages start`) | none: the origin's OPFS | contract `messages`: `drafts`, `attempts` |
| [Vocab](vocab/README.md) | online web; desktop (standalone native) | the web: none, the `vocab` repository; the desktop: `~/Epicenter/Vocab` | contract `vocab`: `entries`, `chats`, `messages` |

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
