# @epicenter/svelte

Svelte state around an opened `@epicenter/folder` handle. The Folder package
owns files, row parsing, whole-source drafts, storage, change reports, local save
status, and unsaved input (`@epicenter/folder/document`). This package owns the
page's query cache, Svelte tracking of that input, in-session recovery,
and synchronous release. It also has separate agent conversation and
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
calls best-effort `flush()` when the page hides, and releases synchronously on close.
Only a pending Folder save prompts before a browser unload. In a desktop
window, the editable page appears only after its close listener is installed.
Closing checks `folder.getStatus().saving` and `folder.getStatus().unsaved` and
awaits a native `confirm(...)` only for unfinished saves. Saved windows close
silently, including while recording: native destruction ends capture and keeps
its audio. Repeated requests for one window share its current answer; other
windows answer independently. Successful destruction keeps the page inert until
it is gone and synchronously closes that page's context after the destroy call
succeeds. Cancel or failure leaves it usable. Save status is sampled once;
a save finishing while the question opens does not withdraw it.

Desktop capabilities grant `dialog:allow-message`, `core:window:allow-set-focus`,
and `core:window:allow-destroy`. No page asks for native recording status or
reports save status to Quit. Epicenter application Quit always confirms in
Rust and adds its native recording warning when capture is active.
Confirming departure accepts losing unfinished work. Await the actual write or
editor save before departure when durable bytes are required.

A descendant calls the already-typed `getFolder()` from `$lib/folder.js` during
initialization. The context contains `folder`, `queryClient`,
`queries.rows(table)`, `queries.files()`, `queries.documents()`, `queries.file(path, reader)`, `getStatus()`, `closing`,
`guardWindowClose`, `refresh`, and `close`.
Context `close(): void` stops change, focus, and window listeners, unmounts
the query client, closes the folder, and clears the cache synchronously.
`FolderStatus.closing` means close was called. New input, saves, refreshes,
and storage calls refuse. Held input is not submitted; admitted writes may
finish or fail with their own Results. Apps check closing state before starting
work or saving late results. `<FolderApp>` closes on unmount, including a folder
that finishes opening afterwards, without waiting for native guard registration.
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
which acquires it on subscription or refresh. Lists and file queries return
read results without loading an editor. An editing view subscribes to its own
source; a programmatic action explicitly refreshes its document before calling
`document.save(patch)`. `folder.tables.notes.write(id, document)` publishes a complete new
row once, without retaining a failed creation as input. File queries can still
classify size and audio before opening text. The key carries
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
log. `fileDocument.refresh()` returns an individual acquisition result. No query
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

## Reactive documents

The folder owns each path's source, accepted input, reads and write lane
([working documents](../folder/README.md#working-documents)). A table binds its
schema to the same handle that `folder.files.document(path, schema?)` returns.
`saveAfterMs` belongs to the folder opener, not this adapter.

```ts
import { reactiveDocument } from '@epicenter/svelte/document';
import { toastOnError } from '@epicenter/ui/sonner';

// Fixed address, for example in a component keyed by its note.
const fileDocument = reactiveDocument(folder.tables.notes.document(id));
fileDocument.content; // { text, body, fields, issues } | undefined
toastOnError(fileDocument.patch({ fields: { done: true }, body: 'Two litres\n' }), 'That change was not made');
toastOnError(fileDocument.replace(editedSource), 'That change was not made');

// Follow a changing path prop; repeated wrapping reuses the passive adapter.
const sourceDocument = $derived(reactiveDocument(folder.files.document(path)));
```

`reactiveDocument(handle)` returns a `ReactiveDocument` from
`@epicenter/svelte/document`. It exposes the document's cached snapshot as
tracked getters: `.content`, `.loadError`, `.isDirty`, `.isSaving`, and
`.saveError`. Commands remain methods: `replace`, `patch`, `save`, `refresh`, and
`discard`.

`reactiveDocument` privately reuses a passive adapter by document handle through
a WeakMap. Repeated wrapping is safe, including inside derived collections:
unaffected documents keep their existing observations when the collection
recomputes. Use the underlying document handle to identify a document; adapter
equality is not a separate public contract. No whole-Folder wrapper is needed.

Each adapter uses Svelte's `createSubscriber` to bridge its tracked getters to
one document subscription while any effect reads it. The last effect leaving
releases that subscription; retaining or reusing the adapter does not keep it
active. Derive from a changing path prop so the view follows the selected
handle. Caller-managed adapter caching is unnecessary.

The first tracked getter read subscribes before reading the cached snapshot,
starting acquisition when the source is unknown or invalidated. Every getter
participates, including `.isDirty`. Construction and plain reads outside
tracking subscribe to nothing. No `onMount(() => fileDocument.refresh())` is
needed. The last observer leaving stops further read demand after any ongoing
read. The Folder retains acquired source, input, timers, saves, and failures
until `folder.close()`; unmounting a view does not close its document.

Save-only UI reads the context's `getStatus().savingPaths`, `.unsaved`, and
`.failures`, filtered by path. That subscription is passive. Reading any
tracked editor getter, even `.isDirty`, demands content. Keep immediate input
refusals at the interaction boundary, using inline feedback or `toastOnError`;
they are returned Results, not observable save failures.

`.content` is absent while text is awaited (`.loadError` undefined) or when
acquisition failed (`.loadError` set: `Missing`, `NotText` or `ReadFailed`).
Present content is editable even with a `loadError`, which says the latest
read found no text, such as after another program deleted the file.
`issues === null` narrows fields to the bound schema. A malformed header has
`fields: undefined`; its body is available only when a closing fence
identifies it. Keep exact source through `.content.text` for repair.

```svelte
{#each fileDocuments as fileDocument (fileDocument.path)}
  {@const content = fileDocument.content}
  {#if content}
    <textarea bind:value={() => content.text, (text) => toastOnError(fileDocument.replace(text), 'That change was not made')}></textarea>
    {#if fileDocument.loadError}
      <p role="alert">{fileDocument.loadError.message}</p>
    {/if}
    {#if fileDocument.saveError}
      <p role="alert">{fileDocument.saveError.message}</p>
      <button onclick={() => fileDocument.save()}>Retry saving</button>
    {:else if fileDocument.isSaving}
      <p>Saving…</p>
    {:else if fileDocument.isDirty}
      <p>Unsaved changes</p>
    {/if}
  {:else if fileDocument.loadError}
    <p role="alert">{fileDocument.loadError.message}</p>
    <button onclick={() => fileDocument.refresh()}>Read again</button>
  {:else}
    <p>Loading…</p>
  {/if}
{/each}
```

When a binding callback needs a narrowed value, capture it with `{@const}` in
the nearest template block containing its controls, then narrow that local
before creating the callbacks:

```svelte
{#each fileDocuments as fileDocument (fileDocument.path)}
  {@const content = fileDocument.content}
  {#if content && content.issues === null}
    <Input
      bind:value={() => content.fields.title, (title) => fileDocument.patch({ fields: { title } })}
      onblur={() => void fileDocument.save()}
    />
  {/if}
{/each}
```

Avoid a script alias that merely repeats `fileDocument.content`. A plain script
`const` captures a value instead of following it. Name the shared handle or its
reactive adapter `fileDocument`.

`patch({ fields?, body? })` and `replace(text)` return synchronous
`Result<void, ChangeError>`: success means accepted into memory. Full text can
be accepted before acquisition; a structured patch needs acquired text. Both
autosave. Multiple views share one source, so switching views shows the same
text immediately.

`save(input?)` accepts a complete source string or a structured patch, applies
that input synchronously, captures its immutable content, and admits
publication before notifying observers. Its Promise returns
`Result<MarkdownContent<Schema>, ChangeError | SaveError>` with that exact
published content, without a row ID, even when newer input is pending. No-input
`save()` publishes the then-current content, including clean content or a
retry. A control that needs synchronous acceptance can check `replace(text)`
or `patch(patch)` and then call `void fileDocument.save()`; this publishes the source after
acceptance and any observer notification. `discard()` drops unpublished input,
answers its text, and writes nothing. Writes are unconditional: the last
publication wins.

Context `close()` returns nothing and waits for no writes or application
workflows. Retry and copying remain available while the folder is open.

The status UI helpers (`status-line`, `status-popover`, `status-row`) render
app-owned status text. `write-failure` and `write-failure-toast` sample text
from an app-owned `getText()` at each Copy click. They keep attempted text only
for a manual clipboard fallback. Agent conversation bindings
remain independent of Folder.
