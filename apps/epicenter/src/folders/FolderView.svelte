<script lang="ts">
	import {
		DECLARATION_PATH,
		type FileListing,
		type Folder,
		type FolderDefinition,
		type GitSnapshot,
		type PreparedFolderTable,
		type TableListing,
	} from '@epicenter/folder';
	import { visibleRows } from '@epicenter/folder/file-browser';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { onMount } from 'svelte';
	import FieldEditor from './FieldEditor.svelte';
	import { columnsOf, displayOf } from './field-input';
	import {
		createRowEdits,
		type EditUnit,
		editedRow,
		type FieldChange,
		type RowEdit,
	} from './row-edits';
	import { type AnyTable, type Replaced, type StoredAnyRow, saveRow } from './save-row';
	import { changesMessage, type VersionLine, versionMessage } from './version';

	/**
	 * One opened data folder: its tables and their rows, or its files when it
	 * declares no tables, and Save version. Every edit saves at once.
	 * `declarationChanged` is called once the folder's `epicenter.json` reads
	 * as other bytes than when this view opened it, after every queued save
	 * settled: the folder must be opened again to use the new declaration.
	 */
	let {
		folder,
		declarationChanged,
	}: {
		folder: Folder<FolderDefinition>;
		declarationChanged: () => void;
	} = $props();

	type Notice = { readonly text: string };
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
	/** The latest merge with another window's save; stays until dismissed or replaced by a newer one. */
	let mergeNotice = $state<Notice | undefined>(undefined);
	/** The latest save that failed; stays until dismissed or replaced. */
	let saveProblem = $state<Notice | undefined>(undefined);
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
		void checkDeclaration();
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

	/**
	 * The declaration's SHA-256 when this view first read it, `null` for no
	 * file, `undefined` until read.
	 */
	let declaration: string | null | undefined;
	let reopening = false;

	/** Ask for the folder to be opened again once `epicenter.json` changed. */
	async function checkDeclaration() {
		const { data, error } = await folder.files.read(DECLARATION_PATH);
		if (error !== null && error.name !== 'NotFound') return;
		const now = data?.sha256 ?? null;
		if (declaration === undefined) {
			declaration = now;
			return;
		}
		if (now === declaration || reopening) return;
		reopening = true;
		// Queued saves finish against the declaration they were made with.
		await saving;
		declarationChanged();
	}

	function chooseTable(name: string) {
		if (name === tableName) return;
		tableName = name;
		rows = undefined;
		selectedStem = undefined;
		void read();
	}

	/** The row as the grid shows it now, `undefined` when it does not read. */
	function storedOf(stem: string): StoredAnyRow | undefined {
		const item = rows?.find((row) => row.stem === stem);
		return item?.result.error === null ? item.result.data : undefined;
	}

	/** Each edit's starting row, so a read while the person edits is not its base. */
	const edits = createRowEdits();

	function begin(stem: string, unit: EditUnit) {
		const stored = storedOf(stem);
		if (tableName !== undefined && stored !== undefined)
			edits.begin(tableName, stem, unit, stored);
	}

	/** Saves run one at a time, each over the row its edit began from. */
	let saving: Promise<void> = Promise.resolve();

	/**
	 * Save `edit` of row `stem` in the table shown now. Everything it needs is
	 * taken here, when the edit is made: the table and the
	 * row the edit began from (recorded by `begin`, or the row shown now for
	 * an edit made by one click). A save queued behind others still saves to
	 * its own table after the view shows another.
	 */
	function edit(stem: string, unit: EditUnit, change: RowEdit) {
		const name = tableName;
		if (name === undefined) return;
		const handle = folder.tables[name] as AnyTable;
		const start = edits.take(name, stem, unit) ?? storedOf(stem);
		if (start === undefined) return;
		saving = saving
			.then(async () => {
				const base = edits.latest(start);
				const outcome = await saveRow({
					table: handle,
					captured: base,
					edited: await editedRow(start, base, change),
				});
				if (outcome.kind === 'failed') {
					saveProblem = { text: outcome.message };
					revision++;
					await read();
					return;
				}
				edits.saved(base, outcome.stored);
				if (name === tableName && rows !== undefined)
					rows = rows.map((row) =>
						row.stem === stem
							? { stem, result: { data: outcome.stored, error: null } }
							: row,
					);
				if (outcome.kind === 'merged')
					mergeNotice = { text: mergedText(outcome.replaced) };
				// Edits mark the change count stale; read it again.
				void folder.git.status();
			})
			.catch((error: unknown) => {
				// One save that throws must not stop every later one.
				saveProblem = {
					text: `Not saved: ${error instanceof Error ? error.message : String(error)}`,
				};
				revision++;
				void read();
			});
	}

	function mergedText(replaced: readonly Replaced[]): string {
		if (replaced.length === 0) return 'Changed in another window; merged.';
		const parts = replaced.map((item) =>
			item.kind === 'body'
				? `the notes (their lines were ${JSON.stringify(item.theirs.replace(/\n$/, ''))})`
				: `${item.field} (theirs was ${item.theirs === undefined ? 'empty' : JSON.stringify(item.theirs)})`,
		);
		return `Changed in another window; merged. Your edit replaced their change to ${parts.join(', ')}.`;
	}

	function changeField(stem: string, field: string, change: FieldChange) {
		edit(stem, { kind: 'field', field }, { kind: 'field', field, change });
	}

	function changeBody(stem: string, text: string) {
		edit(stem, { kind: 'body' }, { kind: 'body', text });
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
	/** The body the box held when it gained focus. */
	let bodyStart: string | undefined;
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
	{#snippet noticeLine(notice: Notice, problem: boolean, dismiss: () => void)}
		<div class="flex items-start gap-2 border-b px-4 py-2">
			<Alert.Root variant={problem ? 'destructive' : 'default'}>
				<Alert.Description>{notice.text}</Alert.Description>
			</Alert.Root>
			<Button size="xs" variant="ghost" onclick={dismiss}>Dismiss</Button>
		</div>
	{/snippet}
	{#if saveProblem !== undefined}
		{@render noticeLine(saveProblem, true, () => (saveProblem = undefined))}
	{/if}
	{#if mergeNotice !== undefined}
		{@render noticeLine(mergeNotice, false, () => (mergeNotice = undefined))}
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
														begin={() => begin(item.stem, { kind: 'field', field: column.name })}
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
											begin={() => begin(stem, { kind: 'field', field: column.name })}
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
									onfocus={() => {
										bodyStart = storedBody;
										begin(stem, { kind: 'body' });
									}}
									onchange={(event) => changeBody(stem, event.currentTarget.value)}
									onblur={(event) => {
										// Unchanged since focus: show what a read meanwhile brought.
										if (event.currentTarget.value === bodyStart)
											event.currentTarget.value = storedBody;
									}}
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
