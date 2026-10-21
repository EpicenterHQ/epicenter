# @epicenter/svelte

Svelte state around an opened `@epicenter/folder` handle. The Folder package
owns files, row parsing, merging, storage, change reports, local save
status, and unsaved input (`@epicenter/folder/edits`). This package owns the
page's query cache, Svelte tracking of that input, pending actions, recovery,
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
window, the editable page appears only after its close listener is
installed. Closing that window checks `folder.getStatus().saving` and
`folder.getStatus().unsaved`; if either indicates pending work, a native dialog
asks whether to close anyway. An unsubmitted form does not prompt. The native
capability must grant `dialog:allow-message`, `core:window:allow-set-focus`,
and `core:window:allow-destroy`. Epicenter's Quit asks each mounted folder
page for the same status and shows one confirmation if needed. If a save still fails as the route unmounts, the root shows its fields and body for copying in a
notice held by the app layout's toaster.

A descendant calls the already-typed `getFolder()` from `$lib/folder.js` during
initialization. The context contains `folder`, `queryClient`,
`queries.rows(table)`, `queries.files()`, `queries.documents()`, `queries.file(path, reader)`, `queries.read(edit)`, `getStatus()`, `closing`, `run`,
`guardWindowClose`, `refresh`, and `close`.
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
and derive; the editable document of a row or file belongs to its edit (below),
which a row list or a file read through these queries keeps current. The key carries
the decoded data type into `queryClient.getQueryData(options.queryKey)`. There is
no reader registry or options cache. Query functions never change an existing
file's bytes.

One timer in the context rereads active folder queries while the document is
visible. QueryClient selects the reads and joins those already running. The
next poll waits at least two seconds and nine times the preceding batch's read
duration, keeping periodic scanning near 10% of elapsed time. Large folders
therefore update less often. Cached inactive queries are read on mount; becoming
visible also refreshes active queries. Visibility is the document's state,
not OS input focus: two visible desktop windows can both poll. No native focus
listener, file watcher, or wake detector is needed. Closing stops the timer
before draining saves. Failed local reads are shown without automatic retries
inside that read; a later poll or visibility return can try again.

The folder watches no directory, so an edit shown with no list over its file
learns of an outside program's change through `queries.read(edit)`: while a
view observes it, the visible polling reads the edit's file again, and so
does `refresh()` or `refresh([path])`. A change the folder reports is the
edit's own to read, so the refresh that change starts leaves this query
alone.

Every context has its own QueryClient and `['folder']` query prefix. Generated
keys are `['folder', 'rows', table]`, `['folder', 'files']`,
`['folder', 'documents']`, `['folder', 'file', path, representation]`, and
`['folder', 'read', path]`.
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

A label beside one editor reads that edit's own `pending` (`error` without
`saving` means its save failed, otherwise it is saving or waiting), so another
file's failure is never shown as its.

## Row and whole-file edits

The folder owns each path's editable document and typed input from open to
close (`folder.tables.<t>.edit(id)`, `folder.files.edit(path)`; the Folder
README's "Unsaved input" states the rules,
[ADR-0656](../../docs/adr/0656-a-folder-owns-typed-input-from-open-to-close.md)).
`saveAfterMs` is an option of the app's `openFolder` call, not of this package.
`@epicenter/svelte/edits` reads one of those edits in a view:

```ts
import { createRowEdit, createTextEdit } from '@epicenter/svelte/edits';

// This component is keyed by its note, so its address is fixed.
const rowEdit = createRowEdit(folder.tables.notes, id);
const row = $derived(rowEdit.row);
rowEdit.row; // the row as stored, with held input in it; undefined until known
rowEdit.readStatus; // { known: 'nothing' | 'missing' | 'file' | 'not-text', reading, error }
rowEdit.change({ fields: { done: true }, body: 'Two litres\n' });

// If path changes in this component, derive the adapter from that address.
const textEdit = $derived(createTextEdit(folder.files, path));
textEdit.text; // the held text, held fields over the file, or the file
textEdit.change(edited);
textEdit.changeFields({ title: 'x' });
```

The Svelte edit exposes tracked getters over the core's read methods:
`getRow()` becomes `.row`, `getText()` becomes `.text`, `getPending()` becomes
`.pending`, `getReadStatus()` becomes `.readStatus`, and `isLocked()` becomes
`.locked`. Commands stay methods, shared directly with the core. Each getter
re-runs a reader while an effect reads it (`createSubscriber`). The first time an
effect asks for the document (`row`, `text` or `readStatus`) with
nothing known, no read running and no read error, it reads the file; a row a list
already read needs no read of its own. `row` is `undefined` while
nothing is known, after a failed first read, and when no file is there;
`readStatus` tells them apart, the same value for every view of the
path. A failed reread keeps what is shown and says why in `error`; `read()`
reads again. Asking only for `pending` or `locked` requests no new
document; a subscription may refresh one already read. Commands retain
their Folder behavior.

Both adapters expose the same path's pending input, including input created by
the other representation. Valid row changes patch held whole-file text; whole-file
typing takes over applicable row or field input. A structured view reads the
current text with its schema, so ordinary valid switching requires no save or
refresh. Invalid content stays available as text; unapplied fields remain in
pending for recovery. Switching views clears neither input nor its save error.

Row and text edits use the same commands: `save()` sends new input or joins its
running attempt; `retry()` explicitly attempts held failed input again.
Blur, unmount, settlement and close leave failed input held for recovery.
Accepted new input clears the older error and may autosave.

Read properties directly where convenient. When a local helps readability or preserves narrowing in a binding callback, name the value:

```svelte
{#each rowEdits as rowEdit (rowEdit.path)}
  {#if rowEdit.row?.issues === null}
    {@const row = rowEdit.row}
    <Input
      bind:value={() => row.fields.title, title => rowEdit.change({ fields: { title } })}
      onblur={() => void rowEdit.save()}
    />
  {/if}
{/each}
```

`{@const}` is reactive: `row` follows `rowEdit.row` within its template block.
A Folder row is `undefined` when absent; `issues === null` means it is valid.
If script code also needs the value, use `const row = $derived(rowEdit.row)` and
narrow it in the template. A plain script `const row = rowEdit.row` captures the
initial value. Do not replace a missing row with empty input values.

Commands type over what `row` or `text` shows now; there is no
source to name and no last-read snapshot. A command that composes new
content reads the row or text and changes it synchronously.

`change` and `changeFields` return `Result<void, ChangeError>`: `Ok(undefined)`
means accepted into memory, while `Err` explains the refusal. It does not mean
saved. `save()` and `retry()` resolve after their attempt; `pending?.error`
and folder status report a storage failure. A row not read yet or gone returns
`ChangeError.NoSource`, and a file that is not text `ChangeError.NotText`,
leaving earlier input readable through `pending`.

Name adapters `rowEdit` and `textEdit`; reserve `row` and `text` for their
values. Each view creates its own adapter, which reads and holds nothing by
itself. Keep it constant for a fixed address, including a component keyed by
that address. Derive a replacement only when its table/id or files/path changes;
changes to `.row`, `.text` or `.pending` do not require another adapter. `save`, `discard`, `delete`, `retry`
and `exclusive` call the folder's edit.

Use `context.run(action)` for accepted app actions that may write after an
await. A write or exclusive change that enters Folder before the first await
is already covered by `folder.close()`. The context waits for later writes during normal close;
their file writes enter `getStatus()`. `close()` refuses new actions and app input
(`closing`), lets started actions finish, stops the change channel and
cancels reads, then calls `folder.close()`, which fences input, sends it, and
waits for saves. It answers copyable failures, which `<FolderApp>` offers
after unmount: whole-file text exactly as typed, and field input as JSON with
the values set (`set`), the names of the fields removed (`remove`), and a
typed `body` (`unsavedText`), so a removal never reads as a value.

The status UI helpers (`status-line`, `status-popover`, `status-row`) render
app-owned status text. `write-failure` and `write-failure-toast` offer the
unsaved text for app actions that use a toast. Agent conversation bindings
remain independent of Folder.
