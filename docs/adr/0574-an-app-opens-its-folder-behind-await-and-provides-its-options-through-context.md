# 0574. An app opens its folder behind `{#await}` and provides its options through context

- **Status:** Proposed
- **Date:** 2026-10-16
- **Relates:** [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md) (one read path, one channel of change), [ADR-0553](0553-a-pages-own-writes-keep-its-folder-cache-in-step-and-folder-queries-carry-their-read-policy.md) (`folderOptions`, writes keep the cache in step), [ADR-0554](0554-a-field-edit-sets-fields-on-the-file-as-it-is-now.md), [ADR-0583](0583-a-folders-declaration-is-published-only-by-the-app-it-is-named-after.md) (one opener)
- **Unbuilt:** Whispering mounts `<FolderApp>`; it still opens its folder inside its own `Workspace` (`#platform/workspace`), and builds the same edit layer itself (`createEdits`). The generic editor's field and body editors (`FieldEditor`, `RowBody`) still hold their own typed text over the folder's writes. The app stores (`createTodos`, `createNotes`, `createCaptures`, `createVocab`) still wrap the context's `queries` for their views, rather than each component building its queries from `getFolder()`. `FolderContext` still carries `isOwn`, which goes with ownership ([ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md)). `<FolderApp>` still takes `app={manifest}` and passes `manifest.id` to `openFolder`.

## Context

Every app opened its folder in its own root page behind `{#await}`, built
its own store around `folderOptions(folder)`, and repeated the rest:

- a loading screen and a refusal screen, each worded differently;
- the machinery under each store for text typed and not saved: drafts by
  path, a debounced save, offering the text of a file deleted elsewhere, a
  lock while a rename or delete runs, a close fence, "settle every write,
  then commit", and parsing TanStack mutation keys back into paths to know
  which file a write was for. The copies already disagreed: one settle
  looped until no draft saved, another ran once and also waited on Sync;
- a `QueryClient`: Todos made its own with `retry: false`,
  `networkMode: 'always'` and `staleTime: Infinity`, while Honeycrisp,
  Capture and Vocab put a default one in the layout;
- `invalidateOnChange`, in the store in three apps and in the page in
  Capture;
- a write-failure type whose unsaved text was `unsaved`, `unsaved` and
  `kept`, `text`, or `lost` and `retry`, and a "Could not save" toast that
  each app wrote again, so one app could drop the copy-your-text handoff;
- a `describeError` (five copies, each covering a different part of
  `WriteError`) and a `NotStarted` error (four copies);
- closing the folder on teardown.

Todos, Honeycrisp and Capture also kept a browser leaf and a desktop leaf of
`#platform/folder` that differed only in the entry they imported, and Vocab
aliased `@epicenter/folder` to the browser entry. After ADR-0583 the root
`openFolder` opens the folder the shell handed the window on the desktop and
the app's own in a browser, so the leaves had nothing left to choose.

## Decision

**The root page mounts `<FolderApp>` from `@epicenter/svelte` with the app's
definition.** It starts opening when it mounts, with
`openFolder({ id, definition })` from `@epicenter/folder`, where `id` is
the `folder` parameter of the window's URL, or the app's default folder
without one ([ADR-0607](0607-an-app-opens-any-data-folder-by-its-id-on-every-host.md)), and
waits with `{#await}`. Loading is one `Loading` screen; a folder that cannot
open is one `Empty` screen, worded per `OpenFolderError`
(`describeOpenRefusal`), with "Try again" only for a refusal that may pass.
Nothing opens on import, and nothing else opens in a refused folder's place.

```svelte
<!-- +page.svelte -->
<FolderApp definition={reading}><ReadingView /></FolderApp>
```

**`<FolderApp>` owns the page's cache and the folder's lifetime.** It builds
the context with `createFolderContext(folder, { writeFailed })` and provides
it with `<FolderProvider>`:

- one `QueryClient` with one policy: `staleTime: Infinity` and no refetch on
  focus, because the folder's change channel is the one detector of outside
  change (ADR-0548); `networkMode: 'always'`, because reads and writes reach
  files; `retry: false`, because a failure is shown, not retried;
- `queries`, the folder's reads (`folderOptions(folder)`), with
  `invalidateOnChange` wired once, before anything reads;
- `edits`, the one edit layer (`createEdits` from `@epicenter/svelte/edits`)
  every write and every piece of typed text goes through. It writes through
  `folderWrites(folder, queryClient)`, the folder's writes as Result-returning
  functions that keep the cache in step, so writes to one file run in one
  order whoever made them, with no TanStack mutation scope and no focus
  manager override. It holds a row's body, a file's text, and a typed field
  by path until each is in the file: saved a second after the last change
  and when the view leaves it, kept on screen when a save fails, and let go
  with its text offered when the file was deleted elsewhere. `exclusive`
  runs a rename or delete once the drafts of its paths (a rename's source
  and destination) landed, and lets go of what was held there once it
  succeeded; `settled` tries every draft once and waits for every write,
  again until none is left, before Save version and Sync, and answers the
  paths whose typing did not save. A path's unsaved typing blocks anything
  that would move past it on that path: a rename or delete of it, Save
  version, and typing the path another way are refused until it saves or
  the person discards it. Sync goes ahead, since it claims nothing about
  the edit on screen;
- `writeFailed`, one toast for a failed save: `Could not save <path>`, the
  error worded by `describeWriteError`, and "Copy your text" for the unsaved
  text. The toast is the only place that text exists, so it stays up until
  the clipboard took the text or the person dismisses it, and a refused copy
  shows the text to select by hand. "Save again" appears when the edit is
  still on screen, with "Discard your edit"; `retry` answers whether a save
  started, and when none did the toast comes back with only the text. A failed field set offers the
  field the person typed, such as a title, and no text for a click, a move,
  or a delete;
- closing when the page goes away: the edit layer fences input when close
  is called and sends what is typed, then every write, rename, delete, and
  app action lands, the change wiring stops, and the folder is released.

```ts
// @epicenter/svelte/folder
type FolderContext<TDefinition> = {
	folder: Folder<TDefinition, Definition>;
	queries: FolderOptions<TDefinition>;
	edits: Edits<Folder<TDefinition, Definition>['tables']>;
	queryClient: QueryClient;
	writeFailed: (failure: WriteFailure) => void;
	close: () => Promise<void>;
};
type WriteFailure = { path: string; error: DescribedError | OtherError; unsaved: string; retry?: () => boolean };
```

**Every component reads and writes through `getFolder()`.** It builds its
queries on `queries` and its edits on `edits`, and receives no folder as a
prop.

```svelte
<script lang="ts">
	let { stem } = $props();
	const { queries, edits } = getFolder<typeof reading>();
	const books = createQuery(() => queries.books.list.queryOptions());
	const title = edits.field('books', stem, 'title');
</script>
```

**Text typed into a file's field, body, or text is a draft in `edits`;
other input that is not yet committed is local `$state`, bound with
`bind:value`.** Local state covers a new-item box and a search. A committed
value lives only in its file and the queries over it.

An app module adds only what `queries` does not offer, such as a compound
action, and takes the context from `getFolder()` too. It is named for its
rows, never for the opened folder: Todos' `createTodos`, Honeycrisp's
`createNotes`, Capture's `createCaptures`.

## Consequences

- An app keeps its tables, views and domain actions. The open, the
  screens, the query client, the change wiring, the edit layer, the
  write-failure toast and closing are written once.
- A save that fails reaches the person with its unsaved text: an app
  reports `{ path, error, unsaved }` and cannot word the toast without the
  copy action, and nothing closes the toast before the text is copied. A
  text an app does not report, such as a field another view still holds,
  is outside this guarantee.
- Apps keep no `#platform/folder` leaves. The installed build still resolves
  `@epicenter/folder` to the desktop entry through `installedAppViteConfig`,
  and a page in the desktop app is refused rather than given browser storage
  (`packages/folder/src/entries.test.ts`). Vocab's browser build now carries
  the desktop adapter as a chunk it never loads.
- Honeycrisp sets up no table directories in its own folder: a table's
  directory appears with its first file, as it always did in a browser, and
  Git keeps no empty directory.
- A component outside `<FolderApp>` or `<FolderProvider>` cannot call
  `getFolder()`. Tests build the context over a test folder with
  `createFolderContext` and mount views inside `<FolderProvider>`.

## Considered alternatives

- **Opening in a `+layout.ts` load function.** A load function has no
  teardown, so nothing could wait for writes and close the folder when the
  page goes away, and a refusal would leave the component tree.
- **Passing the folder or its options as props.** Every component between the
  root and a reader would carry it.
- **Each app keeping its own toast and passing `onWriteFailed`.** Four
  shapes of the unsaved text existed; one app dropping the copy action was a
  silent loss of typed text.
- **Reading the new-item box from `FormData` on submit.** It needs no state,
  but the form cannot react to what is typed, such as disabling "Add" while
  the box is empty, and two patterns for one kind of input would coexist.
