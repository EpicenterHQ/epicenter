# 0574. An app opens its folder behind `{#await}` and provides its options through context

- **Status:** Proposed
- **Date:** 2026-10-16
- **Relates:** [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md) (shared reads and changes), [ADR-0654](0654-visible-folder-queries-refresh-without-native-watchers.md) (visible query polling), [ADR-0655](0655-product-root-components-use-the-app-name-and-app-suffix.md) (product roots).
- **Amended by:** [ADR-0657](0657-departure-prompts-only-for-pending-folder-saves.md) for departure prompts, and [ADR-0656](0656-a-folder-owns-typed-input-from-open-to-close.md): Folder owns accepted file edits and persistence from construction until close; context connects that owner to the page.
- **Built:** `FolderApp` and `createFolderContext` in `@epicenter/svelte`; app-local typed `getFolder`/`setFolder`; the Todos, Capture, Honeycrisp, Vocab, and Whispering roots.

## Context

Each app repeated opening, loading and refusal screens, query-cache setup,
change subscriptions, and teardown. Apps also kept separate editing queues.
That made view lifetime determine whether pending input participated in closing.
Whispering added session and workspace wrappers that forwarded storage closure.

The common page integration belongs in one component. Persistence must also
work for a plain JavaScript caller, so creating that integration cannot activate
another editing lifetime.

## Decision

`FolderApp` from `@epicenter/svelte/folder-app` receives a zero-argument opener.
The opener selects tables and save policy. Importing it opens nothing.
`FolderApp` calls it on mount, renders loading or a refusal while it waits,
and provides the opened context to the product root through its child snippet.
A retry opens a fresh handle. Changing the callback does not replace an active
folder; choosing another folder requires a new root lifetime.

```svelte
<script lang="ts">
	import { openFolder } from '@epicenter/folder';
	import FolderApp from '@epicenter/svelte/folder-app';
	import { notesTables } from '$lib/definition.js';
	import NotesApp from './NotesApp.svelte';
</script>

<FolderApp open={() => openFolder({ tables: notesTables, saveAfterMs: 1000 })}>
	{#snippet children(context)}
		<NotesApp {context} />
	{/snippet}
</FolderApp>
```

The app binds its context type once:

```ts
import type { FolderContext } from '@epicenter/svelte/folder';
import { createContext } from 'svelte';
import type { notesTables } from './definition.js';

export const [getFolder, setFolder] =
	createContext<FolderContext<typeof notesTables>>();
```

Its product root calls `setFolder(context)` and
`setQueryClientContext(context.queryClient)` during initialization. Descendants
call `getFolder()` during their initialization; no generic argument or separate
provider component is needed. The build selects the folder engine. On desktop
the shell binds the directory before the window exists; no URL or page chooses
a native path. A refused native open never opens browser storage instead.

The context contains the opened Folder and one TanStack Query client. Its
`queries` factory supplies shared keys and readers. Folder's `onChange` marks
affected queries stale after storage commits, including successful no-op saves.
Visible queries poll for outside edits. Display reads stay outside persistence;
a failed or blocked reread cannot turn a successful save into a failure or
prevent Folder from closing.

Each view binds its actual observed source to Folder's passive editing entry
points:

```ts
const { folder, queries } = getFolder();
const notes = createQuery(() => queries.rows('notes'));
const observedRow = $derived(notes.data?.find((row) => row.id === id));
const edit = $derived(
	createRowEdit(folder.tables.notes.edit(id), () => observedRow),
);
// The control displays edit.row and submits through the same binding.
edit.change({ fields: { title: nextTitle }, body: nextBody });
```

There is no context editing namespace or attachment step. Folder retains
accepted input, timing, write ordering, and failures beyond every view's
subscriptions. A new-item form, connection form, selection, or search stays
with the app. Product capabilities and workflows also stay outside Folder.

`context.run(action)` counts accepted app work that may write after an await.
It affects `busy` and closing; `saveState` comes from Folder status alone.
`registerUnsent` identifies forms that would be lost on departure without
submitting them for the person.

On teardown the product stops its workflows and registers their final writes
synchronously through `context.run`. Context refuses new app actions, finishes
accepted actions, stops change subscriptions and reads, then calls
`folder.close()`. Folder fences new input, settles accepted edits, releases
storage, and returns recoverable failures. `FolderApp` offers their unsaved
input for copying. The desktop window guard settles before destruction and
keeps the window open for failures or unsubmitted forms. Application Quit,
Force Quit, and a crash cannot provide that asynchronous guarantee.

## Consequences

- Apps share opening, query integration, page/window behavior, and recovery
  presentation. Folder owns persistence whether a UI context exists or not.
- Each mounted product retains its forms, selections, recording, and inference
  state across routes. Whispering constructs platform capabilities inside its
  product constructor over the opened Folder; its root receives only context.
  These capabilities do not open or close another storage lifetime.
- Tests can construct context over a test Folder. Mounted root tests cover
  opening, startup failure, unmount during reads, and final workflow writes
  before storage closure.

## Considered alternatives

- **Opening in a route load function.** Load has no component teardown to
  initiate closure after accepted work finishes.
- **A separate provider or setter prop.** The existing product root can install
  its typed context and the query client directly.
- **Keeping persistence in the UI context.** Plain JavaScript callers would
  lack autosave and pending-input ownership; attaching later creates a second
  lifecycle boundary.
- **Keeping app session and workspace close forwarding.** Those wrappers add
  another storage lifetime without preserving additional product state.
