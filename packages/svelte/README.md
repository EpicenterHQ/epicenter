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
  reads.
- One edit layer (`edits`), described below.
- One write-failure toast. An app reports
  `{ path, error, unsaved, retry?, discard? }` to `getFolder().writeFailed`; the toast says `Could not save <path>` and
  words the error with `describeWriteError`. It offers the unsaved text with
  "Copy your text" and stays up until the clipboard took it or the person
  dismisses it; a refused copy shows the text in a box to select by hand.
  It offers "Save again" when `retry` is set; `retry` answers whether a save
  started, and when none did the toast comes back with only the text to
  copy. It offers "Discard your edit" when `discard` is set, which lets go
  of the edit on screen and keeps the toast up with the text it let go,
  newer typing included, to copy.
  `@epicenter/svelte/write-failure-toast` exports it as `toastWriteFailure`
  for an app, such as Whispering, that opens its folder itself. A failed
  field set reports the field the person typed, such as a
  title, and no text for a click, a move, or a delete.
- Closing when the page goes away: the edit layer fences input from the
  moment close is called, sends what is typed, waits for every write,
  rename, delete, and app action, then the change wiring stops and the
  folder is released.

`getFolder<typeof definition>()` answers `FolderContext`: `folder`, `isOwn`
(the handle's `folder.own`: the app's own folder, for a feature such as
Todos' Connect), `queries` (the TanStack Query reads over the folder,
`folderOptions(folder)`), `edits`, `queryClient`, `writeFailed`, and
`close`. Call it while a component initializes. An app module that builds
compound actions takes the context from the component that calls it.

`createFolderContext(folder, { writeFailed })` builds the same context over a
folder a test opened, and `<FolderProvider context>` provides it to mounted
views. `@epicenter/svelte/folder` and `@epicenter/svelte/write-failure` are
plain modules, so a store imports them without loading components; the
context builds the edit layer, a runes module, so a test loads
`@epicenter/svelte/folder` with a dynamic `import()` after its runes loader.
`ActionError.NotStarted({ reason })` is the error an app returns for an
action it refused before changing anything.

### The edit layer (`@epicenter/svelte/edits`)

`createEdits({ folder, queries, queryClient, writeFailed })` is the one
place a folder app keeps what a person typed and has not saved, so each
app's store holds only its product logic. `<FolderApp>` builds it as
`getFolder().edits`; Whispering, which opens its folder itself, builds its
own.

```ts
const { edits } = getFolder<typeof todosDefinition>();
const title = edits.field('todos', stem, 'title');
const notes = edits.body('todos', stem);
edits.set('todos', stem, { done: true });
await edits.exclusive(path, () => edits.writes.tables.todos.delete(stem));
await edits.saveVersion();
```

- `edits.writes` is `folderWrites(folder, queryClient)` from
  `@epicenter/folder/query`: the folder's write, move, and row helpers, each
  answering the engine's Result and keeping the cache in step. Writes to one
  file run one at a time, in the order made, whoever made them; `inTurn`
  runs other work in a file's turn.
- `body(table, stem)`, `text(path)`, and `field(table, stem, name)` hold
  what is typed by path until it is in the file. Each saves a second after
  the last change (`SAVE_AFTER_MS`), and at once on `save()`, which a view
  calls when the person leaves the control and when the view goes away. A
  draft outlives its view, and a read never replaces it.
- A save that fails keeps what is typed and reports it to `writeFailed`
  with the text, a `retry` that starts a save while the draft is still
  held and the folder is not closing, and a `discard` that lets it go and
  answers the text it let go. Typing a settle cannot even send, such as a
  body whose row stopped reading, is told once per settle with its text and
  `discard`, so no refusal it causes lacks a way out.
- A path's unsaved typing blocks anything that would move past it on that
  path. While typing whose save failed is held at a path, `exclusive` on
  it answers `ActionError.NotStarted` with `UNSAVED`, `saveVersion()`
  answers `NotStarted` naming the paths, and typing the path another way
  is refused: a file's exact text against its body or fields, either way.
  Sync goes ahead, since it carries what the files hold and claims nothing
  about the edit on screen; `close()` goes ahead once the failure was
  reported. Save again or Discard in the failure's notice is the way out.
- A delete beats an edit that never saw it. A draft whose file was deleted,
  as a save found or a listing without its row says, is let go and its text
  offered once (`NotFound`). A field set on a deleted row offers what was
  typed; `set`, a click, offers nothing.
- `exclusive(paths, work)` runs a rename or delete, whose `work` answers a
  Result, once the drafts and writes of its paths landed; a rename names
  its source and its destination. `locked(path)` and `refusal(path)`
  answer while it runs, and while the folder closes. Once `work`
  succeeded, every draft and field still held at its paths is let go, so
  no Save again reaches an address that was moved or deleted.
- `settled(path?)` sends what is typed and waits for every write, again
  until nothing is left. Each draft is tried once per settle, and again
  only when typing changed it meanwhile; it answers the paths whose typing
  still did not save. `saveVersion()` and `sync({ url? })` start after it.
- A field save names the revision it sent, so one that lands clears only
  that typing, never a value typed after it, even one equal to it.
- `writing(path?)`, `unsaved(path?)`, `busy`, and `fenced` are read
  reactively.
- `close()` fences new input when it is called, then waits for every draft,
  write, lock, and app action; it releases nothing.

### Running a sync from a page

A page runs `edits.sync()` as one of its own mutations: it settles every
draft and write first, then syncs, and reads the page's queries again; this
package keeps no sync state. Sync
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
