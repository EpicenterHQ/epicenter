<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import * as Select from '@epicenter/ui/select';
	import { readSavedViews } from '@epicenter/folder/declaration';
	import { onDestroy } from 'svelte';
	import {
		createViews,
		savedKey,
		TABLES,
		SQL,
		type ViewUpdater,
	} from './views.svelte';
	import TablesView from './TablesView.svelte';
	import SqlView from './SqlView.svelte';
	import { getFolder } from './context.js';
	import { createQuery } from '@tanstack/svelte-query';
	import type { FileDrafts } from './drafts.svelte';
	import FileEditor from './FileEditor.svelte';
	import { fileTree, listKey, fileKey } from './files';

	/** Files, recipes and draft input share one window and one open folder. */
	let { drafts, updateView }: { drafts: FileDrafts; updateView: ViewUpdater } =
		$props();

	const context = getFolder();
	const folder = context.folder;

	const listing = createQuery(() => ({
		queryKey: listKey(context.queries.key),
		queryFn: async () => {
			const listed = await folder.files.list();
			if (listed.error !== null) throw listed.error;
			return listed.data;
		},
	}));
	const tree = $derived(
		listing.data === undefined ? undefined : fileTree(listing.data),
	);
	const held = $derived(new Set(drafts.held));
	const unlisted = $derived(
		drafts.held.filter(
			(path) => listing.error || !listing.data?.includes(path),
		),
	);
	let selected = $state<string | undefined>(undefined);
	let view = $state('files');
	function openSource(path: string) {
		selected = path;
		view = 'files';
	}
	const declaration = createQuery(() => ({
		queryKey: fileKey(context.queries.key, 'epicenter.json'),
		queryFn: async () => {
			const read = await folder.files.read('epicenter.json');
			if (read.error !== null) throw read.error;
			return read.data === undefined
				? null
				: new Uint8Array(await read.data.content.arrayBuffer());
		},
	}));
	const saved = $derived.by(() => {
		try {
			return readSavedViews(
				declaration.data
					? new TextDecoder('utf-8', { fatal: true }).decode(declaration.data)
					: '{}',
			);
		} catch {
			return {
				data: null,
				error: { reason: 'epicenter.json is not UTF-8 text' },
			};
		}
	});
	// The window owns this draft collection for its whole lifetime.
	// svelte-ignore state_referenced_locally
	const source = drafts.file('epicenter.json');
	const views = createViews({
		saved: () => saved.data?.views ?? {},
		update: (change) => updateView(change),
		exclusive: (action) => source.exclusive(action),
		refreshed: async () => {
			await context.refresh(
				{ queryKey: fileKey(context.queries.key, 'epicenter.json') },
				{ throwOnError: true },
			);
		},
	});
	onDestroy(
		context.registerUnsent(() =>
			views.failed
				? 'View settings did not save. Retry, reload or dismiss the failed save before closing.'
				: undefined,
		),
	);
	const recipe = $derived(views.value(view));
	const needsDirectory = $derived(
		recipe !== undefined &&
			recipe.type !== 'sql' &&
			(recipe.table === '*' ||
				recipe.table === '.' ||
				recipe.table.includes('/')),
	);
	const viewError = $derived(views.error(view));
	const storedEntries = $derived(
		Object.entries(saved.data?.views ?? {}).map(
			([key, value]) => [savedKey(key), value] as const,
		),
	);
	const savedEntries = $derived([
		...new Map([...storedEntries, ...views.held]),
	]);
	async function save(asNew = false) {
		const key = view;
		const target = await views.save(key, asNew);
		if (view === key) view = target;
	}

	const status = $derived(context.status);
</script>

<section class="flex h-full min-h-0 flex-1 flex-col">
	<header class="flex flex-wrap items-center gap-3 border-b px-4 py-3">
		<nav class="flex gap-2" aria-label="Folder views">
			<Button
				variant={view === 'files' ? 'secondary' : 'ghost'}
				aria-pressed={view === 'files'}
				onclick={() => (view = 'files')}>Files</Button
			>
			<Button
				variant={view === TABLES ? 'secondary' : 'ghost'}
				aria-pressed={view === TABLES}
				onclick={() => (view = TABLES)}>Tables</Button
			>
			<Button
				variant={view === SQL ? 'secondary' : 'ghost'}
				aria-pressed={view === SQL}
				onclick={() => (view = SQL)}>SQL</Button
			>
		</nav>
		{#if savedEntries.length > 0}<Select.Root
				type="single"
				value={savedEntries.some(([key]) => key === view) ? view : ''}
				onValueChange={(key) => {
					if (key) view = key;
				}}
				><Select.Trigger aria-label="Saved views"
					>{savedEntries.find(([key]) => key === view)?.[1].title ??
						'Saved views'}</Select.Trigger
				><Select.Content
					>{#each savedEntries as [key, value]}<Select.Item value={key}
							>{value.title} ({value.type}){views.dirty(key)
								? ' •'
								: ''}</Select.Item
						>{/each}</Select.Content
				></Select.Root
			>{/if}
		<span class="ml-auto text-sm text-muted-foreground" role="status">
			{#if status.saving}
				Saving…
			{:else if drafts.failures.length > 0}
				<span class="text-destructive">
					Not saved: {drafts.failures.map((failure) => failure.path).join(', ')}
				</span>
			{:else if views.failed}<span class="text-destructive"
					>View settings need attention. Choose the marked view to retry or copy
					them.</span
				>
			{:else if status.storageFailure !== null}
				<span class="text-destructive"
					>A save failed: {status.storageFailure.message}</span
				>
			{/if}
		</span>
	</header>

	{#if declaration.error || saved.error || (saved.data?.diagnostics.length ?? 0) > 0}
		<div class="border-b px-4 py-2 text-sm">
			{#if declaration.error || saved.error}<p class="text-destructive">
					Could not read saved views: {declaration.error?.message ??
						saved.error?.reason}
				</p>{/if}
			{#each saved.data?.diagnostics ?? [] as issue}<p>
					{issue.key}: {issue.kind === 'unsupported'
						? 'This view was made by a newer version and is shown read-only.'
						: issue.reason}
				</p>{/each}
			<Button variant="link" onclick={() => openSource('epicenter.json')}
				>Open epicenter.json</Button
			>
		</div>
	{/if}
	{#if view !== 'files' && recipe}
		<div class="flex flex-wrap items-center gap-2 border-b px-4 py-2">
			<Input
				aria-label="View title"
				value={recipe.title}
				oninput={(event) =>
					recipe &&
					views.edit(view, { ...recipe, title: event.currentTarget.value })}
				class="w-64"
			/>
			{#if views.dirty(view)}<span class="text-sm text-muted-foreground"
					>Unsaved settings</span
				>{/if}
			<Button
				size="sm"
				disabled={source.exclusivePending ||
					declaration.isPending ||
					needsDirectory}
				onclick={() => void save()}
				>{source.exclusivePending
					? 'Saving…'
					: viewError
						? 'Retry save'
						: 'Save view'}</Button
			>
			<Button
				size="sm"
				variant="outline"
				disabled={source.exclusivePending ||
					declaration.isPending ||
					needsDirectory}
				onclick={() => void save(true)}>Save as new</Button
			>
			{#if view !== TABLES && view !== SQL}
				<Button
					size="sm"
					variant="ghost"
					disabled={source.exclusivePending}
					onclick={() => {
						views.reload(view);
						void declaration.refetch();
					}}>Reload settings</Button
				>
				<Button
					size="sm"
					variant="ghost"
					disabled={source.exclusivePending || views.dirty(view)}
					onclick={async () => {
						const key = view;
						if ((await views.remove(key)) && view === key && !views.dirty(key))
							view = TABLES;
					}}>Delete view</Button
				>
			{/if}
		</div>
		{#if needsDirectory}
			<p class="px-4 py-2 text-sm text-muted-foreground" role="status">
				Choose a top-level directory below before saving this table view. All
				Markdown, the folder root, and nested directories remain available for
				browsing.
			</p>
		{/if}
		{#if views.notice(view)}<Alert.Root
				><Alert.Description
					>{views.notice(view)}
					<Button variant="link" onclick={() => void declaration.refetch()}
						>Read again</Button
					></Alert.Description
				></Alert.Root
			>{/if}
		{#if viewError}<Alert.Root variant="destructive"
				><Alert.Description
					><p>View settings did not save: {viewError}</p>
					<Button variant="link" onclick={() => openSource('epicenter.json')}
						>Open epicenter.json</Button
					><Button variant="ghost" onclick={() => views.dismiss(view)}
						>Dismiss failed save</Button
					>
					<pre
						class="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(
							recipe,
							null,
							2,
						)}</pre></Alert.Description
				></Alert.Root
			>{/if}
		{#if view !== TABLES && view !== SQL && !storedEntries.some(([key]) => key === view)}<p
				class="px-4 py-2 text-sm"
			>
				This view was deleted or cannot be read. Your settings are still here;
				use Save as new.
			</p>{/if}
		{#if recipe.type === 'sql'}<SqlView
				{views}
				viewKey={view}
			/>{:else}<TablesView
				{drafts}
				{openSource}
				view={recipe}
				change={(value) => views.edit(view, value)}
			/>{/if}
	{:else if view !== 'files'}
		<div class="p-4">
			<p>
				This saved view was deleted or cannot be read. Choose another view or
				open its source.
			</p>
			<Button variant="link" onclick={() => openSource('epicenter.json')}
				>Open epicenter.json</Button
			>
		</div>
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
										class={[
											'block w-full truncate rounded px-2 py-0.5 text-left hover:bg-muted',
											path === selected && 'bg-muted font-medium',
										]}
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
						<Alert.Description
							>Could not list the files: {listing.error
								.message}</Alert.Description
						>
					</Alert.Root>
				{/if}
				{#if tree === undefined}
					<p class="p-2 text-sm text-muted-foreground">Reading…</p>
				{:else if tree.length === 0}
					<p class="p-2 text-sm text-muted-foreground">This folder is empty.</p>
				{:else}
					<ul class="font-mono text-sm">
						{#each tree as entry (entry.path)}
							<li style:padding-left="{entry.depth * 1.25}rem">
								{#if entry.kind === 'directory'}
									<span class="block truncate px-2 py-0.5 text-muted-foreground"
										>{entry.name}/</span
									>
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
										{entry.name}{#if held.has(entry.path)}<span class="sr-only">
												(not saved yet)</span
											><span class="text-muted-foreground" aria-hidden="true">
												•</span
											>{/if}
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
					<div
						class="flex flex-1 items-center justify-center p-8 text-center text-muted-foreground"
					>
						Choose a file to open it.
					</div>
				{/if}
			</div>
		</div>
	{/if}
</section>
