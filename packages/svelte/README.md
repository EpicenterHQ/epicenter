# @epicenter/svelte

Svelte utilities for synchronizing state with external systems.

## Overview

This package holds the root every folder app mounts (`<FolderApp>`), adapts
agent conversations into Svelte reactivity, and words Sync's result and a
folder's state for the header.

## Installation

This package is part of the Epicenter monorepo and is used internally. To use it in your app:

```json
{
  "dependencies": {
    "@epicenter/svelte": "workspace:*"
  }
}
```

## Available utilities

### The folder app root (`folder-app`, `folder-provider`, `folder`, `write-failure`)

An app's root page mounts `<FolderApp>` with its manifest and its
definition, and everything below it reads the opened folder through
`getFolder()` ([ADR-0574](../../docs/adr/0574-an-app-opens-its-folder-behind-await-and-provides-its-options-through-context.md)):

```svelte
<script lang="ts">
	import FolderApp from '@epicenter/svelte/folder-app';
	import manifest from '../../epicenter.app.json';
	import { todosDefinition } from '$lib/definition.js';
	import TodosView from './components/TodosView.svelte';
</script>

<FolderApp app={manifest} definition={todosDefinition}><TodosView /></FolderApp>
```

`<FolderApp>` owns what every app root used to copy:

- Opening: `openFolder({ app: manifest.id, definition })` from
  `@epicenter/folder`, which picks the host when it is called. In the desktop
  app it opens the folder the shell handed the window; in a browser, the
  app's own. Only the app's own folder has its definition published
  (ADR-0583). `browser` passes browser-folder settings such as Todos'
  `httpFetch`; the commit author defaults to the app's title.
- One loading screen and one refusal screen. The refusal is worded per
  `OpenFolderError` (`describeOpenRefusal`): a folder that does not declare
  the app's tables keeps the library's message naming the app, the folder,
  and each missing table; a window opened for another app says so. Only a
  refusal that may pass offers "Try again". Nothing else is opened in the
  folder's place.
- One query client with one policy: the folder's change channel is the one
  detector of outside change (ADR-0548), so reads are fresh until it reports
  one (`staleTime: Infinity`, no refetch on focus), nothing waits for a
  network (`networkMode: 'always'`), and failures are shown, not retried
  (`retry: false`). `invalidateOnChange` is wired once, before anything
  reads. TanStack's global focus manager counts the page as focused always:
  a mutation waiting its turn in a scope resumes only while the page is
  focused, and a save must not wait for the person to come back.
- One write-failure toast. An app reports `{ path, error, unsaved, retry? }`
  to `getFolder().writeFailed`; the toast says `Could not save <path>` and
  words the error with `describeWriteError`. It offers the unsaved text with
  "Copy your text" and stays up until the clipboard took it or the person
  dismisses it; a refused copy shows the text in a box to select by hand.
  It offers "Save again" when `retry` is set; `retry` answers whether a save
  started, and when none did the toast comes back with only the text to
  copy. A failed field set reports the field the person typed, such as a
  title, and no text for a click, a move, or a delete.
- `beforeClose` steps all start when close is called.
- Closing when the page goes away: the app's `beforeClose` steps run first
  (fence input, send typed text), then every write and action lands, the
  change wiring stops, and the folder is released.

`getFolder<typeof definition>()` answers `FolderContext`: `folder`, `isOwn`
(the handle's `folder.own`: the app's own folder, for a feature such as
Todos' Connect), `queries` (the TanStack Query layer over the folder,
`folderOptions(folder)`), `queryClient`, `writeFailed`, `beforeClose`, and
`close`. Call it while a component initializes. An app module that builds
compound actions takes the context from the component that calls it.

`createFolderContext(folder, { writeFailed })` builds the same context over a
folder a test opened, and `<FolderProvider context>` provides it to mounted
views. `@epicenter/svelte/folder` and `@epicenter/svelte/write-failure` are
plain modules, so a store imports them without loading components.
`ActionError.NotStarted({ reason })` is the error an app returns for an
action it refused before changing anything.

### Running a sync from a page

A page runs `folder.sync.run()` as one of its own mutations, invalidating
the page's queries when it settles; this package keeps no sync state. Sync
asks nothing (ADR-0576): what both sides changed merges into one commit,
and the result is `synced`, `saved` (merged here, not yet on the remote), or
a `SyncError` saying why it stopped.

`describeSync(result, describePush?)` from `@epicenter/svelte/sync-line`
words a result for a toast or a status line. It is a plain module, so status
helpers import it without loading runes. The rest of what a person is told
stays with the page.

### Header status (`@epicenter/svelte/status-line`, `status-popover`, `status-row`)

Honeycrisp, Todos, and Whispering show their folder's state as one summary
button with details. Each app words its own lines; this package holds what
they share.

`status-line` is a plain module: the `StatusLine` shape (`label`, optional
`short` for narrow screens, `detail`, and a `Tone`), `mostSevere(lines)`
(the most severe line, the earlier one on a tie), `withTime`, `localTime`,
`shortOid`, and `changeList` for the changed paths a check saw. Each app
decides which lines may lead its summary and what a calm header says.

`StatusPopover` renders the button and the details: one row per
`{ name, testid, line }` in `details`, then the app's own `StatusRow`s as
children, then a `footer` snippet for actions. `bind:open` is there for an
app that reads something while the details show. `toastStatus(line)` shows an
outcome line as a toast in its tone, so the toast and the details agree.

```svelte
<StatusPopover {summary} details={[{ name: 'Files', testid: 'status-files', line: files }]}>
	<StatusRow name="Folder" class="font-mono text-xs break-all" data-testid="status-folder">
		{location}
	</StatusRow>
	{#snippet footer()}
		<Button size="sm" onclick={saveVersion}>Save version</Button>
	{/snippet}
</StatusPopover>
```

`packages/ui/src/app.css` scans this package's sources, so its Tailwind
classes reach every app that loads the shared stylesheet.

## Contributing

When adding new utilities to this package:

1. Add the utility file to `src/`
2. Export it from `src/index.ts`
3. Update this README with documentation
4. Add type tests if applicable

## Dependencies

This package depends on:

- `@epicenter/folder`: the folder it opens and its query options
- `@tanstack/svelte-query`: the page's query client
- `@epicenter/ui`: the loading and refusal screens and the toast
- `svelte`: For reactive state primitives
- `wellcrafted`: For error handling utilities
