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
| Desktop | a folder on the computer | `openDataFolder` and optional `openAppData` from `@epicenter/folder/tauri` |
| Local web | this browser's files (OPFS), for good | `openDevice(contract)` from `@epicenter/folder/browser` |
| Online web | the person's repository, behind sign-in | `openRemote(contract, { account, site })` from `@epicenter/folder/remote` |

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

Only a variant's root decides the store. Components take the folder, read
through `reactive` from `@epicenter/svelte/reactive`, and never know which
store it is, so a new variant is a new root over the same components. Each
store is adapted for Svelte once, where it is made. Todos has moved the
choice into `openFolder` in `src/lib/app.ts`, which every app follows
([ADR-0766](../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)).

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

The desktop `Startup` hands the shared `DesktopStartup` the app's name,
data contract, and site. Apps with machine-local settings also pass their
AppData contract. `DesktopStartup` opens the folder derived from the site
and shows recovery when a root does not open:

```svelte
<DesktopStartup app="Capture" contract={capture} site={APPS.CAPTURE.url}>
  {#snippet children(_appData, device, site)}
    <DesktopRoot {device} {site}>{@render pages()}</DesktopRoot>
  {/snippet}
</DesktopStartup>
```

In an app not yet moved, an online root is the signed-in layout, which
opens the repository per account and sets each collection its components
read in context, as the desktop root does over its folder:

```svelte
<!-- apps/vocab/src/lib/components/Online.svelte -->
<script lang="ts">
  const { account, children } = $props();
  const client = openRemote(vocab, { account, site: APPS.VOCAB.url });
  const folder = reactive(folderOf(client)); // adapted once, where it is made
  setEntryList(folder.entries);
</script>

{@render children()}
```

UI components read a collection (off `folder`, or from its context), sort
with the app's own order, and read and write through the folder's
collection: `items()`, `invalid()` (notes that do not read, with their
text), and writes made over the version shown. The component that shows a
note makes one editor of it (`todos.edit({ id })`), gates on `exists()`,
and binds its `fields`. See [Todos](todos/README.md),
[Capture](capture/README.md) and the
[Svelte package](../packages/svelte/README.md).

## Running an app

The root `bun dev:<app>` scripts start each app's required development
processes. `bun dev:<app>:desktop` and `bun build:<app>:desktop` start and
build a desktop variant (`capture`, `honeycrisp`, `todos`, `vocab`,
`whispering`); they need a Rust toolchain. Each app README names its route
and test commands.

## Where each app's files live

A desktop app on `epicenter-standalone` opens the folder its shell derives
from its site: `~/Epicenter/<label>` for Epicenter apps and
`~/Epicenter/<owner>/<label>` for other apps. Development builds use
`~/Epicenter Dev` as the root. The folder is made when missing for now.
A failed open shows a recovery screen with Retry. **Set up in Epicenter**
enrolls the folder for local history; connecting a repository there enables transfer.

| App | Surfaces | Desktop folder | Contract |
| --- | --- | --- | --- |
| Epicenter | Folders, Settings | none | none |
| [Todos](todos/README.md) | online web; desktop | `~/Epicenter/todos` | `todos`: `todos` |
| [Capture](capture/README.md) | online web; desktop | `~/Epicenter/capture` | `capture`: `captures` |
| [Honeycrisp](honeycrisp/README.md) | online web; desktop | `~/Epicenter/honeycrisp` | `honeycrisp`: `notes`, `folders` |
| [Vocab](vocab/README.md) | online web; desktop | `~/Epicenter/vocab` | `vocab`: `entries`, `chats`, `messages` |
| [Whispering](whispering/README.md) | local web; desktop | `~/Epicenter/whispering` | `whispering`: `recordings`, `audio`, `transcriptions`, `transformations`, `transformation_runs`, `text_runs`, `shortcuts` |
| [Messages](messages/README.md) | local program (`bun run --cwd apps/messages start`) | none: the origin's OPFS | `messages`: `drafts`, `attempts` |
| [Recorder demo](recorder-demo/README.md) | local web; online web | none | `recorder-demo`: `recordings`, `audio` |

A local web app keeps its files in the origin's OPFS; an online web app
keeps none in the browser. The Epicenter app keeps no data of its own; its
library root, `~/Epicenter` (`~/Epicenter Dev` for a development build, whose
`tauri.dev.conf.json` states `"environment": "development"`), holds the
standalone apps' folders. A
standalone app reaches its folder and its AppData by name, never by path
([ADR-0725](../docs/adr/0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md)),
and whatever is at its folder's path is its own
([ADR-0726](../docs/adr/0726-an-apps-path-is-its-claim.md)).

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
