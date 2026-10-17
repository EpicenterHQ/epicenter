# 0574. An app opens its folder behind `{#await}` and provides its options through context

- **Status:** Proposed
- **Date:** 2026-10-16
- **Relates:** [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md) (one read path, one channel of change), [ADR-0553](0553-a-pages-own-writes-keep-its-folder-cache-in-step-and-folder-queries-carry-their-read-policy.md) (`folderOptions`, writes keep the cache in step), [ADR-0554](0554-a-field-edit-sets-fields-on-the-file-as-it-is-now.md)
- **Unbuilt:** `FolderProvider` and the `getFolder`/`setFolder` context in each app; moving Todos (`createTodos`, `getTodos`), Honeycrisp, Capture, Vocab, and Whispering from app store objects that wrap `folderOptions` to components that call `getFolder()`.

## Context

Every app opens its folder in its root page behind `{#await}`
(`apps/todos/src/routes/+page.svelte`), then builds its own store object
around `folderOptions(folder)`: Todos' `createTodos` returns `rows`, `git`,
and `sync`, and `TodosView` provides it with `setTodos`. Each app wires
`invalidateOnChange` in its own store module
(`apps/todos/src/lib/todos.svelte.ts`, `apps/honeycrisp/src/lib/notes.svelte.ts`,
`apps/vocab/src/lib/vocab.svelte.ts`, and others). The stores differ in shape,
so a component in one app reads and writes differently from a component in
another, and each store repeats what `folderOptions` already offers.

## Decision

**The root starts opening the folder when it mounts and waits with
`{#await}`.** Loading is `Loading`; a folder that cannot open is an `Empty`
screen with the refusal's message. Nothing opens on import.

```svelte
<!-- +layout.svelte -->
<script lang="ts">
	let { children } = $props();
	const opening = openFolder({ app: 'so.epicenter.reading', definition: reading });
</script>

{#await opening}
	<Loading class="h-dvh" label="Opening your reading list…" />
{:then opened}
	{#if opened.error}
		<Empty.Root class="h-dvh"><Empty.Title>Could not open the folder</Empty.Title><Empty.Description>{opened.error.message}</Empty.Description></Empty.Root>
	{:else}
		<FolderProvider folder={opened.data}>{@render children()}</FolderProvider>
	{/if}
{/await}
```

**`FolderProvider` owns the open folder for the page.** It creates the page's
`QueryClient`, builds `folderOptions(folder)` once, provides it with
`setFolder`, connects `invalidateOnChange` once, and on teardown waits for
writes with `whenIdle`, then closes the folder.

```svelte
<!-- FolderProvider.svelte -->
<script lang="ts">
	let { folder, children } = $props();
	const queryClient = new QueryClient();
	const folder$ = folderOptions(folder);
	setFolder(folder$);
	$effect(() => folder$.invalidateOnChange(queryClient));
	onDestroy(() => void whenIdle(queryClient).then(() => folder.close()));
</script>

<QueryClientProvider client={queryClient}>{@render children()}</QueryClientProvider>
```

```ts
// src/lib/folder.ts
export const [getFolder, setFolder] = createContext<FolderOptions<typeof reading>>();
```

**Every component reads and writes through `getFolder()`.** It builds its
queries and mutations on the options, and receives no folder as a prop.

```svelte
<script lang="ts">
	let { stem } = $props();
	const folder = getFolder();
	const book = createQuery(() => folder.books.get.queryOptions(stem));
	const update = createMutation(() => folder.books.update.mutationOptions());
</script>
```

**Input that is not yet committed is local `$state`, bound with
`bind:value`.** This covers a new-item box, a search, and a field being
typed. A committed value lives only in its file and the queries over it.

```svelte
<script lang="ts">
	let title = $state('');
</script>
<Input bind:value={title} />
<Button type="submit" disabled={!title.trim()}>Add</Button>
```

An app module adds only what `folderOptions` does not offer, such as a
compound action or departure. It takes the options from `getFolder()` too,
and does not wrap them in a store object.

## Consequences

- A component reads and writes the same way in every app: `getFolder()`, then
  `createQuery` and `createMutation` on the options.
- `invalidateOnChange`, the page's `QueryClient`, and closing the folder each
  happen in one place per app.
- App store objects that repeat `folderOptions` (`createTodos`' `rows`, for
  example) are deleted. What remains in an app module is app-specific.
- A component outside `FolderProvider` cannot call `getFolder()`. Tests mount
  components inside a provider over a test folder.

## Considered alternatives

- **Opening in a `+layout.ts` load function.** A load function has no
  teardown, so nothing could wait for writes and close the folder when the
  page goes away, and a refusal would leave the component tree.
- **Passing the folder or its options as props.** Every component between the
  root and a reader would carry it.
- **Reading the new-item box from `FormData` on submit.** It needs no state,
  but the form cannot react to what is typed, such as disabling "Add" while
  the box is empty, and two patterns for one kind of input would coexist.
