<script lang="ts">
	import type { SvelteFolder } from '@epicenter/svelte/folder-next';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import * as Select from '@epicenter/ui/select';
	import { readSavedViews } from '@epicenter/folder/declaration';
	import {
		createViews,
		savedKey,
		TABLES,
		SQL,
	} from './views.svelte';
	import TablesView from './TablesView.svelte';
	import SqlView from './SqlView.svelte';
	import FileEditor from './FileEditor.svelte';
	import { fileTree } from './files';


	/** Files, recipes and held input share one window and one open folder. */

	let { folder }: { folder: SvelteFolder<Record<never, never>> } = $props();
	const tree = $derived(fileTree(folder.files.map((file) => file.path)));
	let selected = $state<string | undefined>(undefined);
	let view = $state('files');
	function show(next: string, path?: string) {
		if (path !== undefined) selected = path;
		view = next;
	}
	function openSource(path: string) {
		show('files', path);
	}
	const declaration = $derived(folder.file('epicenter.json'));
	const source = $derived(declaration?.data);
	const loadProblem = $derived(declaration?.readError?.message ?? (source instanceof Uint8Array ? 'epicenter.json is not UTF-8 text' : undefined));
	const saved = $derived(readSavedViews(typeof source === 'string' ? source : '{}'));
	const views = createViews({
		saved: () => saved.data?.views ?? {},
		onRemoveFailed: (message) => toast.error(message),
		declaration: {
			text: () => loadProblem ? null : typeof source === 'string' ? source : undefined,
			write: (text) => folder.write('epicenter.json', text),
		},
	});
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

</script>

<section class="flex h-full min-h-0 flex-1 flex-col">
	<header class="flex flex-wrap items-center gap-3 border-b px-4 py-3">
		<nav class="flex gap-2" aria-label="Folder views">
			<Button
				variant={view === 'files' ? 'secondary' : 'ghost'}
				aria-pressed={view === 'files'}
				onclick={() => show('files')}>Files</Button
			>
			<Button
				variant={view === TABLES ? 'secondary' : 'ghost'}
				aria-pressed={view === TABLES}
				onclick={() => show(TABLES)}>Tables</Button
			>
			<Button
				variant={view === SQL ? 'secondary' : 'ghost'}
				aria-pressed={view === SQL}
				onclick={() => show(SQL)}>SQL</Button
			>
		</nav>
		{#if savedEntries.length > 0}<Select.Root
				type="single"
				value={savedEntries.some(([key]) => key === view) ? view : ''}
				onValueChange={(key) => {
					if (key) show(key);
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
		{#if folder.saving}
				Saving…
			{:else}Saved
			{/if}
		</span>
	</header>

	{#if loadProblem || saved.error || (saved.data?.diagnostics.length ?? 0) > 0}
		<div class="border-b px-4 py-2 text-sm">
			{#if loadProblem || saved.error}<p class="text-destructive">
					Could not read saved views: {loadProblem ??
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
				disabled={!!loadProblem || needsDirectory}
				onclick={() => view = views.save(view)}
				>{viewError ? 'Retry save' : 'Save view'}</Button
			>
			<Button
				size="sm"
				variant="outline"
				disabled={!!loadProblem || needsDirectory}
				onclick={() => view = views.save(view, true)}>Save as new</Button
			>
			{#if view !== TABLES && view !== SQL}
				<Button
					size="sm"
					variant="ghost"
					onclick={() => {
						views.reload(view);
						void folder.refresh();
					}}>Reload settings</Button
				>
				<Button
					size="sm"
					variant="ghost"
					disabled={views.dirty(view)}
					onclick={() => {
						if (views.remove(view)) view = TABLES;
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
		{#if viewError}<Alert.Root variant="destructive"
				><Alert.Description
					><p>View settings did not save: {viewError}</p>
					<Button variant="link" onclick={() => openSource('epicenter.json')}
						>Open epicenter.json</Button
					>
					<pre
						class="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(
							recipe,
							null,
							2,
						)}</pre></Alert.Description
				></Alert.Root
			>{/if}
		{#if view !== TABLES && view !== SQL && !storedEntries.some(([key]) => key === view) && !views.submitting(view)}<p
				class="px-4 py-2 text-sm"
			>
					This view was deleted or cannot be read. Your settings are still here;
				use Save as new.
			</p>{/if}
		{#if recipe.type === 'sql'}<SqlView
				{views}
				viewKey={view}
			/>{:else}<TablesView
				{folder}
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
				{#if tree.length === 0}
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
									onclick={() => show('files', entry.path)}
									>
										{entry.name}
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
						<FileEditor {folder} path={selected} />
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
