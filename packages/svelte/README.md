# @epicenter/svelte

Svelte state around an opened `@epicenter/folder` handle. The Folder package
owns files, row parsing, whole-source drafts, storage, change reports, local save
status, and unsaved input (`@epicenter/folder/edits`). This package owns the
page's query cache, Svelte tracking of that input, recovery,
and close sequence. It also has separate agent conversation and
status UI helpers.

## Folder app root

Bind the app's table type once in `src/lib/folder.ts`:

```ts
import type { FolderContext } from '@epicenter/svelte/folder';
import { createContext } from 'svelte';
import type { todosTables } from './definition.js';

export const [getFolder, setFolder] =
	createContext<FolderContext<typeof todosTables>>();
```

Mount one `<FolderApp>` at the route that owns the folder:

```svelte
<script lang="ts">
	import { openFolder } from '@epicenter/folder';
	import FolderApp from '@epicenter/svelte/folder-app';
	import { todosTables } from '$lib/definition.js';
	import TodosApp from './local/TodosApp.svelte';
</script>

<FolderApp open={() => openFolder({ tables: todosTables })}>
	{#snippet children(context)}
		<TodosApp {context} />
	{/snippet}
</FolderApp>
```

The existing app root, `TodosApp`, installs its own module's context during
initialization. It captures this opened context for its lifetime:

```svelte
<script lang="ts">
	import { setQueryClientContext } from '@tanstack/svelte-query';
	import { type getFolder, setFolder } from '$lib/folder.js';

	let { context }: { context: ReturnType<typeof getFolder> } = $props();
	// svelte-ignore state_referenced_locally
	setFolder(context);
	// svelte-ignore state_referenced_locally
	setQueryClientContext(context.queryClient);
</script>
```

The app supplies a zero-argument `open` callback. It can be inline, as above;
creating the callback opens nothing. `FolderApp` calls it when mounted and
again on retry, then connects the page to the returned folder's lifetime and
closes it when the page goes away; the folder itself owns typed input and its
saves. Each call
must open a fresh handle. Updating the callback does not reopen an active
folder; remount the component to choose another folder. The app root provides
the opened context to its descendants. The setter stays in the app; no setter
prop or separate provider component is needed.

The app's callback calls `openFolder({ tables })`, which each build's exact alias of
`@epicenter/folder` resolves to one engine. In a browser it opens this
origin's fixed IndexedDB folder. In a desktop window it opens the directory
the shell bound to that window before the window existed; the page names no
path. It never falls back to browser storage if a native open fails. Opening needs
no account, remote, or network. The root shows a loading or refusal screen,
sends held input when the page hides, and closes after pending work settles.
Only a pending Folder save prompts before a browser unload. In a desktop
window, the editable page appears only after its close listener is installed.
Closing checks `folder.getStatus().saving` and `folder.getStatus().unsaved` and
awaits a native `confirm(...)` only for unfinished saves. Saved windows close
silently, including while recording: native destruction ends capture and keeps
its audio. Repeated requests for one window share its current answer; other
windows answer independently. Successful destruction keeps the page inert until
it is gone. Cancel or failure leaves it usable. Save status is sampled once;
a save finishing while the question opens does not withdraw it.

Desktop capabilities grant `dialog:allow-message`, `core:window:allow-set-focus`,
and `core:window:allow-destroy`. No page asks for native recording status or
reports save status to Quit. Epicenter application Quit always confirms in
Rust and adds its native recording warning when capture is active.
If a save still fails as the route unmounts, the
root shows its exact unsaved source for copying in a
notice held by the app layout's toaster.

A descendant calls the already-typed `getFolder()` from `$lib/folder.js` during
initialization. The context contains `folder`, `queryClient`,
`queries.rows(table)`, `queries.files()`, `queries.documents()`, `queries.file(path, reader)`, `getStatus()`, `closing`,
`guardWindowClose`, `refresh`, and `close`.
Context close stops the change channel and calls `folder.close()` immediately.
`FolderStatus.closing` becomes true at that call, retained edits refuse new
input, and `folder.run` refuses new actions. Accepted work finishes through the
same `folder.files` and `folder.tables`, which stay usable until close
releases storage. The Folder drains that work, the writes it started, and held
input before releasing storage. The context cancels page reads and clears its
cache; it owns no second action queue or close phase. `<FolderApp>` starts this
close when it unmounts and does not wait for it: it finishes while the page's
runtime lives, and a destroyed window or an unloading page does not wait.
Every save, own or not, reaches the context through the folder's one change
channel (`onChange`), which also names a save of this handle that changed
nothing; the context marks the queries over the named paths stale. No save
waits for a reread. `refresh([path])` refreshes every representation at that
path, descendants when it names a directory, matching row tables, and
whole-folder reads such as the listing and documents. `refresh()` refreshes
everything; `refresh([])` does nothing. Affected unobserved file entries are
forgotten so reopening a deleted or recreated file cannot show an old read.
Disabled observers remain attached.

Define each app-specific file representation once:

```ts
import { defineFileRead } from '@epicenter/svelte/folder-queries';

const sourceRead = defineFileRead('source', async (files, path) => {
	const read = await files.read(path);
	if (read.error !== null) throw read.error;
	return read.data === undefined ? null : await read.data.content.text();
});

const source = createQuery(() => context.queries.file(path, sourceRead));
const paths = createQuery(() => context.queries.files());
await context.refresh([path]);
```

The factory generates the key and query function together. Representation names
must be unique within a context: one name always identifies the same cached data
shape and read policy. A representation can own `gcTime` and `structuralSharing`;
view options such as `enabled` and `select` stay at the observer. Queries list
and derive; the editable source of a row or file belongs to its editor (below),
which acquires it on subscription or refresh. Table reads also acquire their
parsed source before resolving, so a list can immediately offer structured
editing. A raw file query leaves a passive editor unacquired, allowing size and
audio classification before opening text. The key carries
the decoded data type into `queryClient.getQueryData(options.queryKey)`. There is
no reader registry or options cache. Query functions never change an existing
file's bytes.

Folder-wide events invalidate affected queries and refresh subscribed editors.
Bun and Tauri watch their directory; browser tabs broadcast committed changes.
Hints carry paths rather than file contents, so each owner reads the source it
needs. There is no periodic query or editor polling.

`context.refresh(paths?)` reconciles both query results and known editors;
`folder.refresh(paths?)` reconciles the editor owner alone. Paths include
descendants, omitted paths mean all, and `[]` means none. Active editor readers
refresh now, while inactive acquired sources become stale for their next
subscription. Returning to a visible window reconciles active queries and
editors after missed events. These events are best effort, not a durable change
log. `fileEdit.refresh()` returns an individual acquisition result. No query
reads for an editor.

Every context has its own QueryClient and `['folder']` query prefix. Generated
keys are `['folder', 'rows', table]`, `['folder', 'files']`,
`['folder', 'documents']`, and `['folder', 'file', path, representation]`.
Query prefixes match array elements. The context separately handles filesystem
descendants when refreshing paths. Apps neither build these keys nor subscribe
to folder changes.

`getStatus()` is `folder.getStatus()` read reactively, the one record of
accepted local work: `saving`, the `unsaved` paths, held `failures`, the last
`storageFailure` until a save lands, and `closing`. An app action that saves
nothing yet is not in it and does not affect the departure prompt. A
folder-wide header formats these facts in the app's own words, usually held
failures first, then `saving` or `unsaved`, then a past `storageFailure`, then
saved:

```ts
const { failures, saving, unsaved, storageFailure } = context.getStatus();
if (failures.length > 0) return 'Not saved';
if (saving || unsaved.length > 0) return 'Saving…';
if (storageFailure !== null) return 'A save failed';
return 'Saved on this device';
```

A save indicator that needs no file contents reads `getStatus().unsaved` and
`getStatus().failures`, filtering by path. These reads request no initial file
read. An open editor reads its own `isDirty`, `isSaving` and `saveError`, so
another file's failure is never shown as its.

## File edits

The folder owns each path's source, accepted input, reads and write lane
(`@epicenter/folder`, "Editors"). A table binds its schema to the same editor
that `folder.files.edit(path, schema?)` returns. `saveAfterMs` belongs to the
folder opener, not this adapter.

```ts
import { createFileEdit } from '@epicenter/svelte/edits';

// Fixed address, for example in a component keyed by its note.
const fileEdit = createFileEdit(folder.tables.notes.edit(id));
fileEdit.content; // { text, body, fields, issues } | undefined
fileEdit.change({ fields: { done: true }, body: 'Two litres\n' });
fileEdit.replaceText(editedSource);

// Derive the adapter from the address; the same editor answers the same adapter.
const sourceEdit = $derived(createFileEdit(folder.files.edit(path)));
```

The adapter exposes the editor's snapshot as tracked getters: `.content`,
`.loadError`, `.isDirty`, `.isSaving` and `.saveError`. Commands stay methods:
`replaceText`, `change`, `save`, `refresh` and `discard`. It is memoized by
editor handle, so keyed widgets that acquire one editor share one adapter, and
it keeps one folder subscription while any effect reads it, released when
none does. Each snapshot change re-runs every reader of the adapter. The
first tracked read subscribes before reading the snapshot, which starts the
editor's first read; the subscription's synchronous first notification is
skipped, as `fromStore` skips it. Construction and reads outside tracking
subscribe to nothing. No `onMount(() => fileEdit.refresh())` is needed. The
folder keeps input, timers and failures when every view unmounts.

`.content` is absent while text is awaited (`.loadError` undefined) or when
acquisition failed (`.loadError` set: `Missing`, `NotText` or `ReadFailed`).
Present content is editable even with a `loadError`, which says the latest
read found no text, such as after another program deleted the file.
`issues === null` narrows fields to the bound schema. A malformed header has
`fields: undefined`; its body is available only when a closing fence
identifies it. Keep exact source through `.content.text` for repair.

```svelte
{#each fileEdits as fileEdit (fileEdit.path)}
  {@const content = fileEdit.content}
  {#if content}
    <textarea bind:value={() => content.text, (text) => fileEdit.replaceText(text)}></textarea>
    {#if fileEdit.loadError}
      <p role="alert">{fileEdit.loadError.message}</p>
    {/if}
    {#if fileEdit.saveError}
      <p role="alert">{fileEdit.saveError.message}</p>
      <button onclick={() => fileEdit.save()}>Retry saving</button>
    {:else if fileEdit.isSaving}
      <p>Saving…</p>
    {:else if fileEdit.isDirty}
      <p>Unsaved changes</p>
    {/if}
  {:else if fileEdit.loadError}
    <p role="alert">{fileEdit.loadError.message}</p>
    <button onclick={() => fileEdit.refresh()}>Read again</button>
  {:else}
    <p>Loading…</p>
  {/if}
{/each}
```

When a binding callback needs a narrowed value, capture it with `{@const}` in
the nearest template block containing its controls, then narrow that local
before creating the callbacks:

```svelte
{#each fileEdits as fileEdit (fileEdit.path)}
  {@const content = fileEdit.content}
  {#if content && content.issues === null}
    <Input
      bind:value={() => content.fields.title, (title) => fileEdit.change({ fields: { title } })}
      onblur={() => void fileEdit.save()}
    />
  {/if}
{/each}
```

Avoid a script alias that merely repeats `fileEdit.content`. A plain script
`const` captures a value instead of following it. Name the editing capability
`fileEdit`.

`change({ fields?, body? })` and `replaceText(text)` return
`Result<void, ChangeError>`: success means accepted into memory, not saved.
Multiple views share one source, so switching views shows the same text
immediately. `save()` publishes the exact current text; `discard()` drops
unpublished input, answers its text, and writes nothing. Writes are
unconditional: the last publication wins, and nothing merges or conflicts.

Use `folder.run(async () => ...)` for work that must finish through close.
It admits the action at the call; it reserves no path and locks nothing.
Await what it needs to finish before it returns, since close waits for the
callback and the writes it started, not for a continuation left running. Do
not await `folder.close()` or `folder.settle()` inside it. Context `close()`
answers copyable failures, which `<FolderApp>` offers after unmount as the
exact unsaved source (`unsavedText`).

The status UI helpers (`status-line`, `status-popover`, `status-row`) render
app-owned status text. `write-failure` and `write-failure-toast` offer the
unsaved text for app actions that use a toast. Agent conversation bindings
remain independent of Folder.
