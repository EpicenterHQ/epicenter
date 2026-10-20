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
Held input or an unsubmitted form prompts before a browser unload. In a
desktop window, the editable page appears only after its close listener is
installed. Closing that window sends held input and waits for accepted local saves;
failed saves and unsubmitted forms keep it open and bring it forward, including
when it is a background native tab. The native capability must grant
`core:window:allow-set-focus` and `core:window:allow-destroy`. Application Quit remains
immediate. If a save still fails as the route unmounts, the root shows its fields and body for copying in a
notice held by the app layout's toaster.

A descendant calls the already-typed `getFolder()` from `$lib/folder.js` during
initialization. The context contains `folder`, `queryClient`,
`queries.rows(table)`, `queries.files()`, `queries.documents()`, `queries.file(path, reader)`, `getStatus()`, `closing`, `getSaveState()`, `busy`, `leaving`, `run`,
`registerUnsent`, `settled`, `guardWindowClose`, `refresh`, and `close`.
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
view options such as `enabled` and `select` stay at the observer. Rows,
documents, and file representations keep structural sharing off unless the
representation turns it on, so a newer read reaches a view as new values and an
edit handle can tell how old the value a view shows is. The key carries
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

`getSaveState()` comes from `folder.getStatus()` alone: `saved` only when no input is
held, no save runs, and no failure is held. Held input whose save failed is
`failed`. A storage failure with nothing held is `recent-failure`. An app
action that saves nothing yet, such as a request it waits for, counts in
`busy` and `leaving` and keeps a window open, but is not `saving`. The app chooses the words shown
to a person, such as "Saved on this device".

## Row and whole-file edits

The folder owns typed input from open to close (`folder.tables.<t>.edit(id)`,
`folder.files.edit(path)`; the Folder README's "Unsaved input" states the
rules, [ADR-0656](../../docs/adr/0656-a-folder-owns-typed-input-from-open-to-close.md)).
`saveAfterMs` is an option of the app's `openFolder` call, not of this package.
`@epicenter/svelte/edits` binds one handle to one view:

```ts
import { createRowEdit, createTextEdit } from '@epicenter/svelte/edits';

const edit = $derived(createRowEdit(folder.tables.notes.edit(id), () => row));
edit.row; // the row shown: `row` with held input and own saves over it
edit.change({ fields: { done: true }, body: 'Two litres\n' });

const text = $derived(createTextEdit(folder.files.edit(path), () => bytes));
text.text; // the text shown
text.change(edited);
text.changeFields({ title: 'x' });
```

Both bindings use the same commands: `save()` sends new input or joins its
running attempt; `retry()` explicitly attempts held failed input again.
Blur, unmount, settlement and close leave failed input held for recovery.
Accepted new input clears the older error and may autosave.

A source that can be missing gives an optional `row`. Inside its rendered
branch, use a template constant to narrow the row for binding callbacks:

```svelte
{#if edit.row}
  {@const shown = edit.row}
  <Input
    bind:value={() => shown.fields.title, title => edit.change({ fields: { title } })}
    onblur={() => void edit.save()}
  />
{/if}
```

`{@const}` is reactive: `shown` follows changes to `edit.row` while the branch
stays open. The local value lets binding callbacks read its fields without a
non-null assertion. If script code also needs the value, use
`const shown = $derived(edit.row)` instead. A plain script
`const shown = edit.row` captures the initial value.

`observed` is the value the view reads from its query: a row, or the file's
bytes through `fileBytes` or `rowBytes`. Getters and commands use the current
projection of that source with held input and own saves. Reading a getter
changes no command policy; there is no separate last-read snapshot or `seen`.
A command that composes new content reads `row` or `text` and changes it
synchronously. Delayed work that intentionally edits an earlier snapshot uses
the core handle explicitly: keep `const shown = handle.shown(observed)` and
later call `handle.change(shown.source, patch)`. The core merges changes from
older snapshots into current input.

`change` and `changeFields` return `Result<void, ChangeError>`: `Ok(undefined)`
means accepted into memory, while `Err` explains the refusal. It does not mean
saved. `save()` and `retry()` resolve after their attempt; `pending.error` and
folder status report a storage failure. A missing observed row returns
`ChangeError.NoSource`, leaving earlier input readable through `pending`.

Each view makes its own binding; making one reads and holds nothing. Make a
new one when its row or path changes. `pending` reads held input, `locked`
reads the operation lock, and `save`, `discard`, `delete`, `retry` and
`exclusive` call the handle. A getter re-runs when input at that path changes,
through a subscription that lives while an effect reads it.

Use `context.run(action)` for accepted app actions that may write after an
await. The context counts them in `busy` and waits for them during close;
their file writes determine `getSaveState()`. `close()` refuses new actions and app input
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
