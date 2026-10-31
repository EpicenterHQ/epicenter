# Apps

An app's data is a layout of files that its contract describes
(`defineContract` from `@epicenter/definition/contract`), and Git is the
record of that layout
([ADR-0700](../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
An app opens its store through `@epicenter/folder` as one typed client,
`Client<Contract>`, with `list`, `get`, `create`, `update` and `delete`; any
program that writes the layout is a valid writer. Apps never commit:
Epicenter (`epicenter sync`) commits a folder on a computer, and the server
commits each web write.

## Variants

An app has up to three variants, each with one store for its life, and
builds only the ones it needs. Nothing moves between stores; signing in
grants capabilities, never storage.

| Variant | Store | Opened with |
| --- | --- | --- |
| Desktop | a folder on the computer | `openAppData` and `openDataFolder` from `@epicenter/folder/tauri` |
| Local web | this browser's files (OPFS), for good | `openDevice(contract)` from `@epicenter/folder/browser` |
| Online web | the person's repository, behind sign-in | `openRemote(contract, { account })` from `@epicenter/folder/remote` |

| App | Variants |
| --- | --- |
| Capture, Honeycrisp, Todos, Vocab | online web, desktop |
| Whispering | local web, desktop |
| Messages | local (a program on the computer where Beeper Desktop runs) |
| Recorder demo | local web (`/`) and online web (`/online`) |

Each desktop variant is a Tauri program of its own
([ADR-0701](../docs/adr/0701-apps-run-as-separate-programs.md)). Capture,
Honeycrisp, Todos, Vocab and Whispering share the
[`epicenter-standalone`](../packages/tauri-epicenter-standalone/README.md)
crate, which also describes how a web app gains a desktop variant.

## Svelte app root

Only a variant's root decides the store. Components take the client, or its
`fromClient` wrapper from `@epicenter/svelte/client`, and never know which
store it is, so a new variant is a new root over the same components. Each
store is wrapped for Svelte once, where it is made.

An app with a desktop variant chooses the root at build time through its
`#platform/root` seam: the browser leaf by default, the desktop leaf under the
`tauri` condition (`bun run build:native`). The app's layout awaits the
variant's `Startup` under a boundary:

```svelte
<!-- apps/capture/src/routes/(app)/+layout.svelte -->
<script lang="ts">
  import { Startup } from '#platform/root';
  import { Loading } from '@epicenter/ui/loading';

  let { children } = $props();
</script>

<svelte:boundary>
  {#snippet pending()}
    <Loading class="h-dvh" />
  {/snippet}
  <Startup>{@render children()}</Startup>
</svelte:boundary>
```

The desktop `Startup` awaits the app's two roots, its AppData and its data
folder, and renders the shared recovery screen (`@epicenter/svelte/recovery`)
when one does not open:

```svelte
<!-- apps/capture/src/lib/components/Startup.svelte, abridged -->
<script lang="ts">
  const appData = $derived(await again(attempt, () => openAppData(captureSettings)));
  const device = $derived(appData.error === null ? await openDataFolder(capture, { appData: appData.data }) : null);
</script>

{#if appData.error !== null}
  <Recovery app="Capture" error={appData.error} {retry} />
{:else if device?.error}
  <Recovery app="Capture" error={device.error} appData={appData.data} {retry} />
{:else if device !== null}
  <DesktopRoot appData={appData.data} device={device.data}>{@render children()}</DesktopRoot>
{/if}
```

An online root is the signed-in layout, which opens the repository per
account and sets it in context:

```svelte
<!-- apps/todos/src/lib/components/Online.svelte -->
<script lang="ts">
  const { account, children } = $props();
  setRepo(fromClient(openRemote(todos, { account }))); // wrapped once, where it is made
</script>

{@render children()}
```

UI components sort with the app's own order, and read and write through
`fromClient` state: tracked `items`, `invalid` (notes that do not read, with
their text), and writes that pass the version shown; `fieldEdit` binds one
field to an immediate editor. See [Todos](todos/README.md),
[Capture](capture/README.md) and the
[Svelte package](../packages/svelte/README.md).

Only the Epicenter app itself still opens folders with the older
`openFolder` and `<OpenFolder>` (its folder editor and AI connections).

## Running an app

The root `bun dev:<app>` scripts start each app's required development
processes. `bun dev:<app>:desktop` and `bun build:<app>:desktop` start and
build a desktop variant (`capture`, `honeycrisp`, `todos`, `vocab`,
`whispering`); they need a Rust toolchain. Each app README names its route
and test commands.

## Where each app's files live

A desktop app on `epicenter-standalone` keeps its data folder at
`~/Epicenter/<productName>` by default, made when missing, or at the folder
the person chose with "Choose data folder…", remembered as `folder` in the
`settings.md` of the app's AppData directory. There is no first-run
question. A development build's `productName` is "<App> Dev", so it keeps
`~/Epicenter/<App> Dev` and an AppData of its own. A folder that cannot open
shows a recovery screen, never another folder silently. Epicenter syncs the
folder once the person presses Sync with Epicenter.

| App | Surfaces | Desktop folder | Contract |
| --- | --- | --- | --- |
| Epicenter | Folders, editor, Settings | `~/Epicenter/so.epicenter` (its records) | none: `openFolder` tables, `connections` |
| [Todos](todos/README.md) | online web; desktop | `~/Epicenter/Todos` | `todos`: `todos` |
| [Capture](capture/README.md) | online web; desktop | `~/Epicenter/Capture` | `capture`: `captures` |
| [Honeycrisp](honeycrisp/README.md) | online web; desktop | `~/Epicenter/Honeycrisp` | `honeycrisp`: `notes`, `folders` |
| [Vocab](vocab/README.md) | online web; desktop | `~/Epicenter/Vocab` | `vocab`: `entries`, `chats`, `messages` |
| [Whispering](whispering/README.md) | local web; desktop | `~/Epicenter/Whispering` | `whispering`: `recordings`, `audio`, `transcriptions`, `transformations`, `transformation_runs`, `text_runs`, `shortcuts` |
| [Messages](messages/README.md) | local program (`bun run --cwd apps/messages start`) | none: the origin's OPFS | `messages`: `drafts`, `attempts` |
| [Recorder demo](recorder-demo/README.md) | local web; online web | none | `recorder-demo`: `recordings`, `audio` |

A local web app keeps its files in the origin's OPFS; an online web app
keeps none in the browser. The Epicenter app keeps its records in the folder
plugin's library root, `~/Epicenter` (`~/Epicenter Dev` in development, or
`EPICENTER_FOLDER_DIR`).

Local Books keeps its QuickBooks replica in SQLite under
`<AppData>/apps/so.epicenter.local-books`, outside the library. `api`,
`landing`, and `posthog-reverse-proxy` are infrastructure and open no folder.

## Product root names

Name each product root `<Product>App`: `TodosApp`, `CaptureApp`,
`HoneycrispApp`, `VocabApp`, `WhisperingApp`, and `MessagesApp`. This
component receives the store its variant's root opened, as a client or a
collection of one, and composes the product's state and interface over it;
nothing under it chooses a store.

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
