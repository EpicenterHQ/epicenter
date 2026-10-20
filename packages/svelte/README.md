# @epicenter/svelte

Svelte state around an opened `@epicenter/folder` handle. The Folder package
owns files, row parsing, merging, storage, change reports, and local save
status. This package owns the page's query cache, drafts, pending actions,
recovery, and close sequence. It also has separate agent conversation and
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
	import TodosView from './local/TodosView.svelte';
</script>

<FolderApp open={() => openFolder({ tables: todosTables })}>
	{#snippet children(context)}
		<TodosView {context} />
	{/snippet}
</FolderApp>
```

The existing app root, `TodosView`, installs its own module's context during
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
again on retry, then owns saving and closing the returned folder. Each call
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
sends drafts when the page hides, and closes after pending work settles. A
pending draft or unsubmitted form prompts before a browser unload. In a
desktop window, the editable page appears only after its close listener is
installed. Closing that window sends drafts and waits for accepted local saves;
failed saves and unsubmitted forms keep it open and bring it forward, including
when it is a background native tab. The native capability must grant
`core:window:allow-set-focus` and `core:window:allow-destroy`. Application Quit remains
immediate. If a save still fails as the route unmounts, the root shows its fields and body for copying in a
notice held by the app layout's toaster.

A descendant calls the already-typed `getFolder()` from `$lib/folder.js` during
initialization. The context contains `folder`, `queryClient`,
`queries.rows(table)`, `queries.files()`, `queries.documents()`, `queries.file(path, reader)`, `edits`, `status`, `saveState`, `busy`, `leaving`, `run`,
`registerWork`, `registerUnsent`, `settled`, `guardWindowClose`, `refresh`, and
`close`. Own saves report paths to the context's only change listener.
`refresh([path])` refreshes every representation at that path, descendants when
it names a directory, matching row tables, and whole-folder reads such as the
listing and documents. `refresh()` refreshes everything; `refresh([])` does
nothing. A save waits for older reads, then rereads without cancelling storage
work, before releasing its draft. Affected unobserved file entries are forgotten
so reopening a deleted or recreated file cannot show an old save base. Disabled
observers remain attached.

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
view options such as `enabled` and `select` stay at the observer. The key carries
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

Every context has its own QueryClient and `['folder']` query prefix. Generated
keys are `['folder', 'rows', table]`, `['folder', 'files']`,
`['folder', 'documents']`, and `['folder', 'file', path, representation]`.
Query prefixes match array elements. The context separately handles filesystem
descendants when refreshing paths. Apps neither build these keys nor subscribe
to folder changes.

`saveState` is `saved` only when no draft or action is pending and no failure
is held. A failed row or app-owned draft is `failed`. A storage failure with
no held draft is `recent-failure`. The app chooses the words shown to a
person, such as "Saved on this device".

## Row and whole-file edits

`edits.row(table, id)` holds a row's typed fields and body with the source it
started from. `shown(row)` overlays the held draft on a fresh read. `change`
schedules a save after a pause, and `save()` sends it now. Saves for one row
run in order; the Folder merges a save with storage changes that landed
meanwhile. A failed save keeps the draft and its error until a successful
retry or an explicit discard. `edits.delete` waits for the row's save and
refuses to discard a failed draft.

`edits.text(path)` holds exact whole-file text. `change(from, text)`
captures the source bytes or text the person edited; `save()` sends it now.
A successful save calls `refresh([path])` before releasing its draft. Reads
must not wait for saves, since a save waits for its refreshed reads.

Row patches and whole-file text share one draft, save queue, and deletion
fence per path. A change cannot replace the other kind of pending input.
Before switching representations, save the current input and check that it
is no longer held. Failed input remains available for retry, copying, or
explicit discard. `edits.failures` retains its row shape; `textFailures`
reports the path, exact text, and error for whole-file failures.
`edits.deleteFile(path)` drains either kind before conditionally deleting a
file from its current bytes.

Use `context.run(action)` for started file actions. Apps with other pending
work can still use `context.registerWork({ busy, failed, settle })`; text
edits owned by `edits` need no registration. The context includes all edits
and registered work in `saveState` and waits for them before closing the
Folder handle. `close()` fences input, sends drafts, waits for accepted work,
releases the change listener, and clears the cache. It returns copyable
failures, including exact whole-file text, which `<FolderApp>` offers after
unmount.

The status UI helpers (`status-line`, `status-popover`, `status-row`) render
app-owned status text. `write-failure` and `write-failure-toast` offer the
unsaved text for app actions that use a toast. Agent conversation bindings
remain independent of Folder.
