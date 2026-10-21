# @epicenter/svelte

Svelte state around an opened `@epicenter/folder` handle. The Folder package
owns files, row parsing, merging, storage, change reports, local save
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
root shows its fields and body for copying in a
notice held by the app layout's toaster.

A descendant calls the already-typed `getFolder()` from `$lib/folder.js` during
initialization. The context contains `folder`, `queryClient`,
`queries.rows(table)`, `queries.files()`, `queries.documents()`, `queries.file(path, reader)`, `queries.read(edit)`, `getStatus()`, `closing`,
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

## File edits

The folder owns each path's editable source, unsaved input, reads and save queue.
A table binds its schema to the same editor that `folder.files.edit(path, schema?)`
returns. `saveAfterMs` belongs to the folder opener, not this adapter.

```ts
import { createFileEdit } from '@epicenter/svelte/edits';

// Fixed address, for example in a component keyed by its note.
const fileEdit = createFileEdit(folder.tables.notes.edit(id));
fileEdit.markdown; // interpret current source only where the view needs it
fileEdit.change({ fields: { done: true }, body: 'Two litres\n' });
fileEdit.replaceText(editedSource);

// Derive a new adapter only when this address changes.
const sourceEdit = $derived(createFileEdit(folder.files.edit(path)));
```

The adapter tracks the core reads: `getMarkdown()` becomes `.markdown`,
`getText()` becomes `.text`, `getPending()` becomes `.pending`,
`getReadStatus()` becomes `.readStatus`, and `isLocked()` becomes `.locked`.
Commands stay methods. `.markdown` contains exactly `text`, `body`, `fields`
and `issues`; it interprets the same source `.text` returns. `issues === null`
narrows fields to the bound schema. No usable text means `undefined`;
`.readStatus` distinguishes loading, missing, non-text and failed reads.
A malformed header has `fields: undefined`; its body is available only when a
closing fence identifies it. Keep exact source through `.text` for repair.
`.pending` contains raw, non-generic input shared across every schema-bound view
of the path. New field values are copied when accepted, including nested values;
changing the original object afterwards does not change the edit.

The first tracked markdown, text or read-status read starts the initial file
read when nothing is known and no read has failed. Reading only `.pending`
or `.locked` requests no initial read. A failed read waits for `read()`;
a failed reread retains the last known source. `read()` completes the refresh;
use the getters afterwards for current values. Creating an adapter is passive.
The folder retains input, timers and failures when every view unmounts.

Read `fileEdit.markdown` directly for immediate template reads. When a binding
callback needs a narrowed value, capture it with `{@const}` in the nearest
template block containing its controls, then narrow that local before creating
the callbacks. For example, each rendered edit owns one local:

```svelte
{#each fileEdits as fileEdit (fileEdit.path)}
  {@const markdown = fileEdit.markdown}
  {#if markdown && markdown.issues === null}
    <Input
      bind:value={() => markdown.fields.title, title => fileEdit.change({ fields: { title } })}
      onblur={() => void fileEdit.save()}
    />
  {/if}
{/each}
```

Avoid a script alias that merely repeats `fileEdit.markdown`. Keep a local snapshot
when a condition or callback needs its narrowing. A plain script `const` captures
a value instead of following it. Name the editing capability `fileEdit`.

`change({ fields?, body? })` patches named fields and replaces the supplied body,
preserving other units. `replaceText(text)` replaces the complete source.
Both return `Result<void, ChangeError>`: success means accepted into memory,
not saved. Multiple views share the path's applicable input and truthful pending
state, so valid view switching requires no save-and-refresh handshake. Invalid
source remains readable; structured input that cannot apply remains in pending
for copying, saving again or discarding.

`save()` attempts held input, including a previous failure, or joins its running
attempt. Failure keeps input and error without looping. Another attempt or
accepted input clears the older error. `discard()` and `delete()` use the same
owner and fence. For path membership, use the folder context's
`getStatus().unsaved`; for the actual input, use `.pending` on an existing edit.

Use `folder.run(paths, async () => ...)` for work that must finish through
close. `paths` is the action's reservation, declared up front and fixed for the
action: those paths reserve local input together and flush it before the
callback starts, and overlapping reservations refuse. A reservation is not a
storage transaction or a limit on which paths the callback may write; raw
storage calls and other programs keep their own content witnesses. An empty
path list admits the lifetime without reporting saving by itself. The callback
uses `folder.files` and `folder.tables`; await what it needs to finish before
it returns, since close waits for the callback and the writes it started, not
for a continuation left running. Do not await `folder.close()` or
`folder.settle()` inside the callback, since they wait for accepted work. Context `close()` answers copyable failures,
which `<FolderApp>` offers
after unmount: whole-file text exactly as typed, and field input as JSON with
the values set (`set`), the names of the fields removed (`remove`), and a
typed `body` (`unsavedText`), so a removal never reads as a value.

The status UI helpers (`status-line`, `status-popover`, `status-row`) render
app-owned status text. `write-failure` and `write-failure-toast` offer the
unsaved text for app actions that use a toast. Agent conversation bindings
remain independent of Folder.
