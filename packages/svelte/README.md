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
	import FolderApp from '@epicenter/svelte/folder-app';
	import { todosTables } from '$lib/definition.js';
	import TodosView from './local/TodosView.svelte';
</script>

<FolderApp title="Todos" tables={todosTables}>
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

`FolderApp` owns opening, saving, and closing. The app root provides the opened
context to its descendants. The setter stays in the app; no setter prop or
separate provider component is needed.

The root calls `openFolder({ tables })`, which each build's exact alias of
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
`queries.rows(table)`, `edits`, `status`, `saveState`, `busy`, `leaving`, `run`,
`registerWork`, `registerUnsent`, `settled`, `guardWindowClose`, and `close`. Its single `onChange` subscription
invalidates reads for the paths reported by the folder. Reads stay fresh
until that notification, do not refetch on focus, and do not retry a failed
local read automatically.

`saveState` is `saved` only when no draft or action is pending and no failure
is held. A failed row or app-owned draft is `failed`. A storage failure with
no held draft is `recent-failure`. The app chooses the words shown to a
person, such as "Saved on this device".

## Row edits and file work

`edits.row(table, id)` holds a row's typed fields and body with the source it
started from. `shown(row)` overlays the held draft on a fresh read. `change`
schedules a save after a pause, and `save()` sends it now. Saves for one row
run in order; the Folder merges a save with storage changes that landed
meanwhile. A failed save keeps the draft and its error until a successful
retry or an explicit discard. `edits.delete` waits for the row's save and
refuses to discard a failed draft.

A view that edits whole files keeps its own draft and calls
`context.registerWork({ busy, failed, settle })`. Use `context.run(action)`
for started file actions. The context counts both in `saveState` and waits
for them before it closes the Folder handle. Whole-file work returns the path,
exact unsaved text, and error from `settle()` when a save fails. `close()`
fences row input, sends drafts, waits for work already started, releases the
change listener, and clears the query cache. It returns one copyable failure
shape for row and whole-file drafts that did not save; `<FolderApp>` offers them
after unmount.

The status UI helpers (`status-line`, `status-popover`, `status-row`) render
app-owned status text. `write-failure` and `write-failure-toast` offer the
unsaved text for app actions that use a toast. Agent conversation bindings
remain independent of Folder.
