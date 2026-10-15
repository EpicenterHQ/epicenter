<script lang="ts">
	import type {
		FileListing,
		Folder,
		FolderDefinition,
		GitSnapshot,
		PreparedFolderTable,
		TableListing,
	} from '@epicenter/folder';
	import { visibleRows } from '@epicenter/folder/file-browser';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { onMount } from 'svelte';
	import FieldEditor, { type FieldChange } from './FieldEditor.svelte';
	import { columnsOf, displayOf } from './field-input';
	import { type AnyTable, type Replaced, saveRow } from './save-row';
	import { changesMessage, type VersionLine, versionMessage } from './version';

	/**
	 * One opened data folder: its tables and their rows, or its files when it
	 * declares no tables, and Save version. Every edit saves at once.
	 */
	let { folder }: { folder: Folder<FolderDefinition> } = $props();

	type Notice = { readonly text: string; readonly problem: boolean };
	type Listing = TableListing<Record<string, unknown>>;

	// The folder's own declaration, as `openDataFolder` prepared it when it
	// opened; the type does not carry the prepared mark.
	const tables = $derived(
		folder.definition.tables as Readonly<Record<string, PreparedFolderTable>>,
	);
	const tableNames = $derived(Object.keys(tables));

	let tableName = $state<string | undefined>(undefined);
	let rows = $state<Listing | undefined>(undefined);
	let files = $state<FileListing | undefined>(undefined);
	let readProblem = $state<string | undefined>(undefined);
	let selectedStem = $state<string | undefined>(undefined);
	let notice = $state<Notice | undefined>(undefined);
	/** Bumped when a save fails, so every editor shows the stored values again. */
	let revision = $state(0);
	/** Delivered by `folder.git.subscribe` as soon as the view mounts. */
	let git = $state<GitSnapshot | undefined>(undefined);
	let versionLine = $state<VersionLine | undefined>(undefined);

	const prepared = $derived(
		tableName === undefined ? undefined : tables[tableName],
	);
	const columns = $derived(prepared === undefined ? [] : columnsOf(prepared));
	const selected = $derived(rows?.find((item) => item.stem === selectedStem));
	const changes = $derived(git && changesMessage(git.files));
	const savingVersion = $derived(git?.activity.commit.active ?? false);

	/** Reads that resolve out of order keep only the newest. */
	let readSeq = 0;

	async function read() {
		const seq = ++readSeq;
		const name = tableName;
		if (name === undefined) {
			const { data, error } = await folder.files.list();
			if (seq !== readSeq) return;
			files = data ?? undefined;
			readProblem = error?.message;
			return;
		}
		const { data, error } = await (folder.tables[name] as AnyTable).list();
		if (seq !== readSeq || name !== tableName) return;
		readProblem = error?.message;
		if (data !== null)
			rows = [...data].sort((a, b) =>
				a.stem.localeCompare(b.stem, undefined, { numeric: true }),
			);
	}

	function chooseTable(name: string) {
		if (name === tableName) return;
		tableName = name;
		rows = undefined;
		selectedStem = undefined;
		void read();
	}

	/** Saves run one at a time, each from the row as last read or saved. */
	let saving: Promise<void> = Promise.resolve();

	function edit(
		stem: string,
		change: (fields: Record<string, unknown>) => void,
		body?: string,
	) {
		const name = tableName;
		const table = prepared;
		if (name === undefined || table === undefined) return;
		saving = saving.then(async () => {
			const item = rows?.find((row) => row.stem === stem);
			if (item === undefined || item.result.error !== null) return;
			const captured = item.result.data;
			const fields = { ...captured.row.fields };
			change(fields);
			const outcome = await saveRow({
				table: folder.tables[name] as AnyTable,
				prepared: table,
				captured,
				edited: { fields, body: body ?? captured.row.body },
			});
			if (outcome.kind === 'failed') {
				notice = { text: outcome.message, problem: true };
				revision++;
				await read();
				return;
			}
			if (name === tableName && rows !== undefined)
				rows = rows.map((row) =>
					row.stem === stem
						? { stem, result: { data: outcome.stored, error: null } }
						: row,
				);
			notice =
				outcome.kind === 'merged'
					? { text: mergedText(outcome.replaced), problem: false }
					: undefined;
			// Edits mark the change count stale; read it again.
			void folder.git.status();
		});
	}

	function mergedText(replaced: readonly Replaced[]): string {
		if (replaced.length === 0) return 'Changed in another window; merged.';
		const parts = replaced.map((item) =>
			item.kind === 'body'
				? 'the notes'
				: `${item.field} (theirs was ${item.theirs === undefined ? 'empty' : JSON.stringify(item.theirs)})`,
		);
		return `Changed in another window; merged. Your edit replaced their change to ${parts.join(', ')}.`;
	}

	function changeField(stem: string, name: string, change: FieldChange) {
		edit(stem, (fields) => {
			if (change.kind === 'remove') delete fields[name];
			else
				Object.defineProperty(fields, name, {
					value: change.value,
					enumerable: true,
					writable: true,
					configurable: true,
				});
		});
	}

	function changeBody(stem: string, body: string) {
		edit(stem, () => {}, body);
	}

	async function saveVersion() {
		versionLine = undefined;
		versionLine = versionMessage(await folder.git.commit());
	}

	onMount(() => {
		tableName = tableNames[0];
		// Subscribe before the first read so no change falls between them.
		const stopFiles = folder.onFilesChanged(() => void read());
		const stopGit = folder.git.subscribe((snapshot) => {
			git = snapshot;
		});
		const onFocus = () => {
			void read();
			void folder.git.status();
		};
		window.addEventListener('focus', onFocus);
		void read();
		void folder.git.status();
		return () => {
			stopFiles();
			stopGit();
			window.removeEventListener('focus', onFocus);
		};
	});

	let bodyBox = $state<HTMLTextAreaElement | undefined>();
	const storedBody = $derived(
		selected?.result.error === null ? selected.result.data.row.body : '',
	);
	// The box shows the stored body, except while the person is typing in it.
	$effect(() => {
		const text = storedBody;
		revision;
		if (bodyBox !== undefined && document.activeElement !== bodyBox)
			bodyBox.value = text;
	});
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
						onclick={() => chooseTable(name)}
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
			<Button size="sm" variant="outline" disabled={savingVersion} onclick={saveVersion}>
				{savingVersion ? 'Saving version…' : 'Save version'}
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
	{#if notice !== undefined}
		<div class="border-b px-4 py-2">
			<Alert.Root variant={notice.problem ? 'destructive' : 'default'}>
				<Alert.Description>{notice.text}</Alert.Description>
			</Alert.Root>
		</div>
	{/if}
	{#if readProblem !== undefined}
		<div class="border-b px-4 py-2">
			<Alert.Root variant="destructive">
				<Alert.Description>{readProblem}</Alert.Description>
			</Alert.Root>
		</div>
	{/if}

	{#if tableNames.length === 0}
		<div class="min-h-0 flex-1 overflow-auto p-4">
			<p class="mb-3 text-sm text-muted-foreground">No tables in this folder.</p>
			{#if files !== undefined}
				{@const tree = visibleRows(files, new Set(files.directories))}
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
	{:else}
		<div class="flex min-h-0 flex-1">
			<div class="min-h-0 flex-1 overflow-auto">
				{#if rows === undefined}
					<p class="p-4 text-sm text-muted-foreground">Reading…</p>
				{:else if rows.length === 0}
					<p class="p-4 text-sm text-muted-foreground">No rows in this table.</p>
				{:else}
					{#key revision}
						<table class="w-full border-collapse text-sm">
							<thead class="sticky top-0 z-10 bg-background">
								<tr class="border-b text-left">
									<th class="px-3 py-2 font-medium text-muted-foreground">Row</th>
									{#each columns as column (column.name)}
										<th class="px-3 py-2 font-medium">{column.name}</th>
									{/each}
								</tr>
							</thead>
							<tbody>
								{#each rows as item (item.stem)}
									<tr
										class={[
											'border-b align-top',
											item.stem === selectedStem && 'bg-muted/40',
										]}
									>
										<td class="px-3 py-2">
											<button
												type="button"
												class="text-left font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
												onclick={() => (selectedStem = item.stem)}
												title="Open this row"
											>
												{item.stem}
											</button>
										</td>
										{#if item.result.error === null}
											{@const stored = item.result.data}
											{#each columns as column (column.name)}
												<td class="px-2 py-1.5">
													<FieldEditor
														{column}
														value={Object.hasOwn(stored.row.fields, column.name)
															? stored.row.fields[column.name]
															: undefined}
														save={(change) => changeField(item.stem, column.name, change)}
													/>
												</td>
											{/each}
										{:else}
											<td colspan={columns.length} class="px-3 py-2">
												<button
													type="button"
													class="text-left text-sm text-destructive"
													onclick={() => (selectedStem = item.stem)}
												>
													{item.result.error.name === 'InvalidRow'
														? 'This row does not read; it cannot be edited here.'
														: item.result.error.message}
												</button>
											</td>
										{/if}
									</tr>
								{/each}
							</tbody>
						</table>
					{/key}
				{/if}
			</div>

			{#if selected !== undefined}
				<aside class="flex w-96 shrink-0 flex-col overflow-auto border-l">
					<div class="flex items-center justify-between border-b px-4 py-2">
						<h3 class="font-mono text-sm">{selected.stem}</h3>
						<Button size="xs" variant="ghost" onclick={() => (selectedStem = undefined)}>
							Close
						</Button>
					</div>
					{#if selected.result.error === null}
						{@const stored = selected.result.data}
						{@const stem = selected.stem}
						<div class="flex flex-col gap-3 p-4">
							{#key revision}
								{#each columns as column (column.name)}
									<div class="flex flex-col gap-1">
										<span class="text-xs font-medium text-muted-foreground">{column.name}</span>
										<FieldEditor
											{column}
											multiline
											value={Object.hasOwn(stored.row.fields, column.name)
												? stored.row.fields[column.name]
												: undefined}
											save={(change) => changeField(stem, column.name, change)}
										/>
									</div>
								{/each}
							{/key}
							{#each Object.keys(stored.row.fields).filter((key) => !Object.hasOwn(prepared?.fields ?? {}, key)) as extra (extra)}
								<div class="flex flex-col gap-1">
									<span class="text-xs font-medium text-muted-foreground">{extra} (not in the table's fields; kept as is)</span>
									<span class="font-mono text-xs break-all">{displayOf(stored.row.fields[extra])}</span>
								</div>
							{/each}
							<label class="flex flex-col gap-1">
								<span class="text-xs font-medium text-muted-foreground">Notes</span>
								<textarea
									bind:this={bodyBox}
									class="min-h-48 w-full rounded-md border border-input bg-transparent p-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
									onchange={(event) => changeBody(stem, event.currentTarget.value)}
								></textarea>
								<span class="text-xs text-muted-foreground">Saved when you leave the box.</span>
							</label>
						</div>
					{:else if selected.result.error.name === 'InvalidRow'}
						{@const invalid = selected.result.error}
						<div class="flex flex-col gap-3 p-4">
							<p class="text-sm">This row does not read as a row of {tableName}:</p>
							<ul class="list-disc pl-5 text-sm text-destructive">
								{#each invalid.issues as issue, index (index)}
									<li>
										{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}
									</li>
								{/each}
							</ul>
							<pre class="overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap">{invalid.text}</pre>
						</div>
					{:else}
						<p class="p-4 text-sm text-destructive">{selected.result.error.message}</p>
					{/if}
				</aside>
			{/if}
		</div>
	{/if}
</section>
