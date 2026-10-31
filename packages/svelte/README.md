# @epicenter/svelte

This package makes an app's files reactive in Svelte 5: a contract's client
through `fromClient` (`@epicenter/svelte/client`). Each text editor owns an
edit (`fieldEdit`) for what the person typed until that value's save answers.

## A contract's client

`fromClient(client)` takes any `Client<T>` (`openDevice` or `openRemote`) and
gives each collection tracked `items`, `invalid` (notes), `loading`, `error`
and `get(args)`, plus its writes, which pass the version shown. A collection
lists and subscribes only while an effect reads it, and follows every change
the client hears. A listing that fails keeps what showed, sets `error`, and
is tried again after half a second, doubling to 30 seconds, while anyone
reads. A write puts what landed into what shows before it resolves. A note `update` follows `updateNote`: carried over another
writer's change to other fields, a `Conflict` when they changed the same
one, after which the adapter shows theirs and a second save applies over it.
`fieldEdit(notes, args, field)` is one field as an immediate editor, one save
at a time, made over what the person saw when the typing began.

```svelte
<script lang="ts">
  import { openDevice } from '@epicenter/folder/browser';
  import { fieldEdit, fromClient } from '@epicenter/svelte/client';

  const files = fromClient(openDevice(todosContract));
  const todo = $derived(files.todos.get({ id }));
  const title = fieldEdit(files.todos, { id }, 'title');
</script>

{#each files.todos.items as todo (todo.id)}<TodoRow {todo} />{/each}
{#each files.todos.invalid as file (file.path)}<pre>{file.text}</pre>{/each}
<Input bind:value={title.value} />
<Checkbox checked={todo?.done} onCheckedChange={(done) => files.todos.update({ id }, { done })} />
```

An editor that holds a whole-note draft saves it with
`files.todos.replace({ id }, draft, { over })`, where `over` is the version
the draft began from, so another writer's change since is a `Conflict`
instead of being overwritten; without `over`, `replace` writes over the
version shown.

### One store per page: this browser or the repository

An app's web build has up to two variants, each over one store for the
page's life, and nothing moves between them
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).
The local variant reads `fromClient(device).x`, this browser's files, which
its startup opened (`await openDevice(contract)`) and handed down; it works
signed out and offline, and signing in only adds hosted capabilities.
The online variant, under a signed-in layout that wraps the repository
once where it opens it and sets it (`setRepo(fromClient(openRemote(…)))`),
reads `getRepo().x`, the person's repository through the server:

```ts
import { fromClient } from '@epicenter/svelte/client';
import { getRepo } from '@epicenter/svelte/repo';

const local = fromClient(device).todos; // the local variant's pages
const online = getRepo<Todos>().todos; // the online variant's pages, wrapped where it was set
const shown = $derived(local.items.toSorted(openFirst)); // the app's order
```

A page uses one or the other, never both.

### A desktop app's folder

A standalone desktop app (`epicenter-standalone`) keeps the person's files
in its data folder, `~/Epicenter/<productName>` unless the person chose
another (decisions 88 to 97). Its startup opens the AppData root, through
the app's own settings contract, and then the data folder before any page
renders (one top-level `await`, under the
layout's `<svelte:boundary>`, whose `pending` is the UI kit's spinner), and
renders the app's desktop root over both, or `Recovery` when one does not
open. `Recovery` switches on the `OpenDeviceError`: Allow access (the native
picker at that folder; picking it allows it), Choose folder…, Use the
default folder and Retry, as each case needs, each writing or clearing
`folder` in the AppData `settings.md` and then retrying; "Retrying…" shows
while the roots open again (`$effect.pending()`). Without `appData` (the app
could not open its own settings) it offers only Retry. The header reads
`getFolderSync()`, which rechecks on focus whether Epicenter syncs the
folder:

```svelte
<!-- Startup.svelte, under <svelte:boundary> -->
<script lang="ts">
  let attempt = $state(0);
  const retry = () => attempt++;
  const again = <T,>(_attempt: number, open: () => Promise<T>) => open();
  const appData = $derived(await again(attempt, () => openAppData(captureSettings)));
  const device = $derived(appData.error === null ? await openDataFolder(capture, { appData: appData.data }) : null);
</script>

{#if appData.error !== null}
  <Recovery app="Capture" error={appData.error} {retry} />
{:else if device?.error}
  <Recovery app="Capture" error={device.error} appData={appData.data} {retry} />
{:else if device !== null}
  <DesktopRoot appData={appData.data} device={device.data}>…</DesktopRoot>
{/if}

<!-- DesktopRoot.svelte: setAppData(fromClient(appData)), setDevice(fromClient(device)),
     setFolderSync(folderSync({ appData, contract: CONTRACT_URL })) -->
<!-- The header -->
<FolderSyncActions sync={getFolderSync()} /> <!-- Sync with Epicenter until it does -->
<Button onclick={() => sync.chooseDataFolder()}>Choose data folder…</Button>
```

### Leaving while a save is out

Every write through `fromClient` and `fieldEdit` is held for the
page's leave guard from the moment it is asked for (a `fieldEdit` keystroke
counts before its save starts; `title.saving` says so for one editor). Each
app root installs the guard once:

```svelte
<script lang="ts">
  import { guardLeave } from '@epicenter/svelte/leave-guard';
  import { onMount } from 'svelte';

  onMount(guardLeave);
</script>
```

While a write is out, leaving the page asks "Leave site?", and a desktop
window waits for the writes before it closes (closing again while it waits
asks natively). A write made on a client directly, such as a capture of
several files, is held with `holdLeave(write)`.

## Keep typed text in an edit

`fieldEdit` shows what the person typed until that value's save answers,
then follows the collection again. An older answer cannot clear newer
typing. A failed save keeps the typed value and its error while the editor
is mounted; `<UnsavedEdit edit={title} />` from `@epicenter/svelte/unsaved-edit`
shows it inline with Save again, Discard, and Copy. A checkbox, select, or
button writes directly and handles its own returned error near the action.

Call `await title.landed()` when an action needs to know the newest typed
value saved, such as before sending it over a network. A failure remains on
`title.error` and is also returned to stop the action. After teardown,
`landed()` succeeds without saving.

**Composition.** Files are the only durable authority. A collaboration layer (for example a Yjs document) is a session over text units only, the body, and persists through the client's writes like any editor. Agents may write files directly; their changes reach editors through the client's listeners.

The package also exports agent conversation bindings and status display
helpers. Those are independent of file editing.
