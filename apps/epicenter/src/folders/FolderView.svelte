<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import TablesView from './TablesView.svelte';
	import SqlView from './SqlView.svelte';
	import { getFolder } from '@epicenter/svelte/folder';
	import { createQuery } from '@tanstack/svelte-query';
	import type { FileDrafts } from './drafts.svelte';
	import FileEditor from './FileEditor.svelte';
	import { fileTree, listKey } from './files';

	/**
	 * The window's folder: its files as a tree, and the one chosen, edited as
	 * the exact text it holds (`FileEditor`). The editor knows no app's
	 * schema, so it opened the folder with no tables and interprets no row; a
	 * row is a file like any other. Everything shown is read through the
	 * folder context's query cache, which the editor keeps fresh from
	 * `folder.onChange`; this view has no refresh of its own. What is typed
	 * is held by the window (`drafts`), so choosing another file keeps it:
	 * the tree marks each file holding typing not saved, and the header says
	 * whether a save is running or which files did not save.
	 */
	let {
		drafts,
	}: {
		/** The typing held in the folder, which outlives each file's editor. */
		drafts: FileDrafts;
	} = $props();

	const context = getFolder<Record<never, never>>();
	const folder = context.folder;

	const listing = createQuery(() => ({
		queryKey: listKey(context.queries.key),
		queryFn: async () => {
			const listed = await folder.files.list();
			if (listed.error !== null) throw listed.error;
			return listed.data;
		},
	}));
	const tree = $derived(listing.data === undefined ? undefined : fileTree(listing.data));
	const held = $derived(new Set(drafts.held));
	const unlisted = $derived(
		drafts.held.filter((path) => listing.error || !listing.data?.includes(path)),
	);
	let selected = $state<string | undefined>(undefined);
	let view = $state<'files' | 'tables' | 'sql'>('files');
	function openSource(path: string) { selected = path; view = 'files'; }

	const status = $derived(context.status);
</script>

<section class="flex h-full min-h-0 flex-1 flex-col">
	<header class="flex flex-wrap items-center gap-3 border-b px-4 py-3">
		<nav class="flex gap-2" aria-label="Folder views">
			<Button variant={view === 'files' ? 'secondary' : 'ghost'} aria-pressed={view === 'files'} onclick={() => (view = 'files')}>Files</Button>
			<Button variant={view === 'tables' ? 'secondary' : 'ghost'} aria-pressed={view === 'tables'} onclick={() => (view = 'tables')}>Tables</Button>
			<Button variant={view === 'sql' ? 'secondary' : 'ghost'} aria-pressed={view === 'sql'} onclick={() => (view = 'sql')}>SQL</Button>
		</nav>
		<span class="ml-auto text-sm text-muted-foreground" role="status">
			{#if status.saving}
				Saving…
			{:else if drafts.failures.length > 0}
				<span class="text-destructive">
					Not saved: {drafts.failures.map((failure) => failure.path).join(', ')}
				</span>
			{:else if status.storageFailure !== null}
				<span class="text-destructive">A save failed: {status.storageFailure.message}</span>
			{/if}
		</span>
	</header>

	{#if view === 'tables'}
		<TablesView {drafts} {openSource} />
	{:else if view === 'files'}
	<div class="flex min-h-0 flex-1">
		<nav class="w-72 shrink-0 overflow-auto border-r p-2" aria-label="Files">
			{#if unlisted.length > 0}
				<section class="mb-3" aria-label="Unsaved files">
					<h2 class="px-2 py-1 text-sm font-semibold">Unsaved files</h2>
					<ul class="font-mono text-sm">
						{#each unlisted as path (path)}
							<li>
								<button
									type="button"
									title={path}
									aria-current={path === selected ? 'page' : undefined}
									class={['block w-full truncate rounded px-2 py-0.5 text-left hover:bg-muted', path === selected && 'bg-muted font-medium']}
									onclick={() => (selected = path)}
								>
									{path}<span class="sr-only"> (not saved yet)</span>
								</button>
							</li>
						{/each}
					</ul>
				</section>
			{/if}
			{#if listing.error}
				<Alert.Root variant="destructive">
					<Alert.Description>Could not list the files: {listing.error.message}</Alert.Description>
				</Alert.Root>
			{:else if tree === undefined}
				<p class="p-2 text-sm text-muted-foreground">Reading…</p>
			{:else if tree.length === 0}
				<p class="p-2 text-sm text-muted-foreground">This folder is empty.</p>
			{:else}
				<ul class="font-mono text-sm">
					{#each tree as entry (entry.path)}
						<li style:padding-left="{entry.depth * 1.25}rem">
							{#if entry.kind === 'directory'}
								<span class="block truncate px-2 py-0.5 text-muted-foreground">{entry.name}/</span>
							{:else}
								<button
									type="button"
									aria-current={entry.path === selected ? 'page' : undefined}
									class={[
										'block w-full truncate rounded px-2 py-0.5 text-left hover:bg-muted',
										entry.path === selected && 'bg-muted font-medium',
									]}
									title={entry.path}
									onclick={() => (selected = entry.path)}
								>
									{entry.name}{#if held.has(entry.path)}<span class="sr-only"> (not saved yet)</span><span class="text-muted-foreground" aria-hidden="true"> •</span>{/if}
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</nav>

		<div class="flex min-h-0 min-w-0 flex-1 flex-col">
			{#if selected !== undefined}
				{#key selected}
					<FileEditor {drafts} path={selected} />
				{/key}
			{:else}
				<div class="flex flex-1 items-center justify-center p-8 text-center text-muted-foreground">
					Choose a file to open it.
				</div>
			{/if}
		</div>
	</div>
	{/if}
	<div class:hidden={view !== 'sql'} class="min-h-0 flex-1 overflow-auto"><SqlView /></div>
</section>
