<script lang="ts">
	import {
		type Definition,
		type Folder,
		type PreparedFolderTable,
		tableOfSchemaPath,
	} from '@epicenter/folder';
	import { Ok } from 'wellcrafted/result';
	import { visibleRows } from '@epicenter/folder/file-browser';
	import type {
		FolderOptions,
		FolderWritesOf,
		TableOptions,
		TableWrites,
	} from '@epicenter/folder/query';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { untrack } from 'svelte';
	import { commands } from '../ui/bindings.gen';
	import TableGrid from './TableGrid.svelte';
	import {
		changesMessage,
		gitMissingNotice,
		type VersionLine,
		versionMessage,
	} from './version';

	/**
	 * One opened data folder: its tables and their rows, or its files when it
	 * declares no tables, and Save version. Everything shown is read through
	 * `folder$`, the folder's query options, whose cache the app root keeps
	 * fresh from `folder.onFilesChanged`; this view has no refresh of its own.
	 * Everything written goes through `writes`, the folder's ordered writes.
	 * Each field editor sets its own field, and a row's body is saved as a
	 * change from the row it started from (`TableGrid`, ADR-0576).
	 *
	 * `declarationChanged` is called once the folder's table schemas, each
	 * `<table>/.epicenter.json`, read as other bytes than when this view first
	 * read them, a table appearing or going included, after every write to
	 * the folder settled: the folder must be opened again to use the new
	 * declaration.
	 */
	let {
		folder,
		folder$,
		writes,
		declarationChanged,
	}: {
		folder: Folder<Definition>;
		folder$: FolderOptions<Definition>;
		writes: FolderWritesOf<Folder<Definition>['tables']>;
		declarationChanged: () => void;
	} = $props();

	const client = useQueryClient();

	// The folder's own declaration, as `openFolder({ id })` read it when it
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
	/** A table's writes, each in its row's turn. */
	const writesOf = (name: string) =>
		(writes.tables as Record<string, TableWrites<Record<string, unknown>>>)[name]!;

	const files = createQuery(() => ({
		...folder$.files.list.queryOptions(),
		enabled: tableNames.length === 0,
	}));
	const status = createQuery(() => folder$.history.status.queryOptions());
	const changes = $derived(
		status.data && changesMessage(status.data, status.isFetching),
	);
	/** What to say when this computer has no `git` for the folder's history. */
	const gitMissing = $derived(
		status.error?.name === 'GitMissing'
			? gitMissingNotice(status.error.install)
			: undefined,
	);
	let installProblem = $state<string | undefined>(undefined);
	async function installGit() {
		installProblem = undefined;
		const { error } = await commands.installGit();
		if (error !== null) installProblem = error;
	}
	// The writes running land first, so the version holds them.
	const saveVersion = createMutation(() => ({
		mutationKey: ['folder', 'save-version'],
		mutationFn: async () => {
			await writes.idle();
			const outcome = await folder.git.commit();
			void client.invalidateQueries(folder$.pathFilter(['.git']));
			return outcome;
		},
	}));
	let versionLine = $state<VersionLine | undefined>(undefined);

	/** Every file in the folder, to find its tables' schema files. */
	const listing = createQuery(() => folder$.files.list.queryOptions());
	/** The schema files the folder holds now, sorted. */
	const schemaPaths = $derived(
		listing.data?.files
			.map(({ path }) => path)
			.filter((path) => tableOfSchemaPath(path) !== undefined),
	);
	/** The declaration's version: each schema file's path and SHA-256. */
	const declaration = createQuery(() => {
		const paths = schemaPaths ?? [];
		return {
			...folder$.query({
				paths,
				key: ['schemas'],
				queryFn: async () => {
					const versions: string[] = [];
					for (const path of paths) {
						const { data, error } = await folder.files.read(path);
						versions.push(`${path}:${error === null ? data.sha256 : error.name}`);
					}
					return Ok(versions.join('\n'));
				},
			}),
			enabled: schemaPaths !== undefined,
		};
	});
	/** The declaration's version when this view first read it. */
	let declaredAs: string | undefined;
	let reopening = false;
	$effect(() => {
		const now = declaration.isSuccess ? declaration.data : undefined;
		if (now === undefined) return;
		if (declaredAs === undefined) {
			declaredAs = now;
			return;
		}
		if (now === declaredAs || reopening) return;
		reopening = true;
		// Writes running finish against the declaration they were made with.
		void writes.idle().then(declarationChanged);
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

	{#if gitMissing !== undefined}
		<Alert.Root class="rounded-none border-x-0 border-t-0">
			<Alert.Description>
				<p>{gitMissing.text}</p>
				{#if installProblem !== undefined}
					<p class="text-destructive">{installProblem}</p>
				{/if}
				{#if gitMissing.action !== undefined}
					<Button size="sm" variant="outline" class="mt-2" onclick={installGit}>
						{gitMissing.action}
					</Button>
				{/if}
			</Alert.Description>
		</Alert.Root>
	{/if}
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
	{#if tableName !== undefined}
		{@const name = tableName}
		{#key name}
			<TableGrid {name} table={tables[name]!} options={optionsOf(name)} writes={writesOf(name)} />
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
