<script lang="ts">
	import {
		DECLARATION_PATH,
		type Folder,
		type FolderDefinition,
		type PreparedFolderTable,
	} from '@epicenter/folder';
	import { visibleRows } from '@epicenter/folder/file-browser';
	import type { FolderOptions, TableOptions } from '@epicenter/folder/query';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import {
		createMutation,
		createQuery,
		MutationObserver,
		useQueryClient,
	} from '@tanstack/svelte-query';
	import { untrack } from 'svelte';
	import ReplacedNotice from '@epicenter/svelte/replaced-notice';
	import { createRowEdits } from './row-edits.svelte';
	import TableGrid from './TableGrid.svelte';
	import { changesMessage, type VersionLine, versionMessage } from './version';

	/**
	 * One opened data folder: its tables and their rows, or its files when it
	 * declares no tables, and Save version. Everything shown is read through
	 * `folder$`, the folder's query options, whose cache the app root keeps
	 * fresh from `folder.onFilesChanged`; this view has no refresh of its own.
	 * Every edit saves at once (`row-edits.svelte.ts`).
	 *
	 * `declarationChanged` is called once the folder's `epicenter.json` reads
	 * as other bytes than when this view first read it, after every queued
	 * save settled: the folder must be opened again to use the new
	 * declaration.
	 */
	let {
		folder,
		folder$,
		declarationChanged,
	}: {
		folder: Folder<FolderDefinition>;
		folder$: FolderOptions<FolderDefinition>;
		declarationChanged: () => void;
	} = $props();

	const client = useQueryClient();

	// The folder's own declaration, as `openDataFolder` prepared it when it
	// opened; the type does not carry the prepared mark.
	const tables = $derived(
		folder.definition.tables as Readonly<Record<string, PreparedFolderTable>>,
	);
	const tableNames = $derived(Object.keys(tables));
	// This view is made again for each opened folder, so its tables are fixed.
	let tableName = $state<string | undefined>(untrack(() => tableNames[0]));

	/** A table's query options; every row is untyped in a folder opened by its declaration. */
	const optionsOf = (name: string) =>
		folder$.tables[name] as TableOptions<Record<string, unknown>>;

	const edits = createRowEdits((name, variables) =>
		new MutationObserver(client, optionsOf(name).save.mutationOptions()).mutate(
			variables,
		),
	);

	const files = createQuery(() => ({
		...folder$.files.list.queryOptions(),
		enabled: tableNames.length === 0,
	}));
	const status = createQuery(() => folder$.history.status.queryOptions());
	const changes = $derived(
		status.data && changesMessage(status.data, status.isFetching),
	);
	const saveVersion = createMutation(() =>
		folder$.history.saveVersion.mutationOptions(),
	);
	let versionLine = $state<VersionLine | undefined>(undefined);

	/** The declaration's version: its SHA-256, `null` for no file. */
	const declaration = createQuery(() =>
		folder$.files.read.queryOptions(DECLARATION_PATH),
	);
	/** The declaration's SHA-256 when this view first read it, `null` for no file. */
	let declaredAs: string | null | undefined;
	let reopening = false;
	$effect(() => {
		const now = declaration.isSuccess
			? declaration.data.sha256
			: declaration.error?.name === 'NotFound'
				? null
				: undefined;
		if (now === undefined) return;
		if (declaredAs === undefined) {
			declaredAs = now;
			return;
		}
		if (now === declaredAs || reopening) return;
		reopening = true;
		// Queued saves finish against the declaration they were made with.
		void edits.settled().then(declarationChanged);
	});

	async function saveNewVersion() {
		versionLine = undefined;
		versionLine = versionMessage(await saveVersion.mutateAsync());
	}
</script>

<section class="flex min-h-0 flex-1 flex-col">
	<header class="flex flex-wrap items-center gap-3 border-b px-4 py-3">
		<h2 class="text-lg font-semibold">{folder.definition.title ?? 'Folder'}</h2>
		{#if tableNames.length > 0}
			<nav class="flex flex-wrap gap-1" aria-label="Tables">
				{#each tableNames as name (name)}
					<Button
						size="sm"
						variant={name === tableName ? 'secondary' : 'ghost'}
						aria-current={name === tableName ? 'page' : undefined}
						onclick={() => (tableName = name)}
					>
						{name}
					</Button>
				{/each}
			</nav>
		{/if}
		<div class="ml-auto flex items-center gap-3">
			{#if changes !== undefined}
				<span class="text-sm text-muted-foreground">{changes}</span>
			{/if}
			<Button
				size="sm"
				variant="outline"
				disabled={saveVersion.isPending}
				onclick={saveNewVersion}
			>
				{saveVersion.isPending ? 'Saving version…' : 'Save version'}
			</Button>
		</div>
	</header>

	{#if versionLine !== undefined}
		<p
			class={[
				'border-b px-4 py-2 text-sm',
				versionLine.problem ? 'text-destructive' : 'text-muted-foreground',
			]}
			role="status"
		>
			{versionLine.text}
		</p>
	{/if}
	{#if edits.problem !== undefined}
		<div class="flex items-start gap-2 border-b px-4 py-2">
			<Alert.Root variant="destructive">
				<Alert.Description>{edits.problem}</Alert.Description>
			</Alert.Root>
			<Button size="xs" variant="ghost" onclick={edits.dismissProblem}>Dismiss</Button>
		</div>
	{/if}
	{#each edits.notices as notice (notice.id)}
		<div class="border-b px-4 py-2">
			<ReplacedNotice
				replaced={notice.saved.replaced}
				subject={notice.stem}
				onRestore={() => edits.restore(notice)}
				onDismiss={() => edits.dismiss(notice)}
			/>
		</div>
	{/each}

	{#if tableName !== undefined}
		{@const name = tableName}
		{#key name}
			<TableGrid {name} table={tables[name]!} options={optionsOf(name)} {edits} />
		{/key}
	{:else}
		<div class="min-h-0 flex-1 overflow-auto p-4">
			<p class="mb-3 text-sm text-muted-foreground">No tables in this folder.</p>
			{#if files.error}
				<Alert.Root variant="destructive">
					<Alert.Description>{files.error.message}</Alert.Description>
				</Alert.Root>
			{:else if files.data !== undefined}
				{@const tree = visibleRows(files.data, new Set(files.data.directories))}
				{#if tree.length === 0}
					<p class="text-sm text-muted-foreground">This folder is empty.</p>
				{:else}
					<ul class="font-mono text-sm">
						{#each tree as entry (entry.path)}
							<li style:padding-left="{entry.depth * 1.25}rem" class="py-0.5">
								{entry.kind === 'directory' ? `${entry.name}/` : entry.name}
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		</div>
	{/if}
</section>
