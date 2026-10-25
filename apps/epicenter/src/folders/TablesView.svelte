<script lang="ts">
	import { documentsOf, type DocumentCache } from '@epicenter/folder/documents';
	import type { SvelteFolder } from '@epicenter/svelte/folder-next';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import * as Select from '@epicenter/ui/select';
	import * as Table from '@epicenter/ui/table';
	import * as Alert from '@epicenter/ui/alert';
	import { applyView, boardLanes } from './view.js';
	import TableControls from './TableControls.svelte';
	import FieldCell from './FieldCell.svelte';
	import BooleanCell from './BooleanCell.svelte';
	import BoardMove from './BoardMove.svelte';
	import type { TableView } from './views.svelte.js';

	let { folder, openSource, view, change }: {
		folder: SvelteFolder<Record<never, never>>;
		openSource: (path: string) => void;
		view: TableView;
		change: (value: TableView) => void;
	} = $props();
	const cache: DocumentCache = new WeakMap();
	const reading = $derived(documentsOf(folder.files, cache));
	const directory = $derived(view.table);
	const directories = $derived([
		...new Set([
			...reading.documents.map((doc) => doc.directory),
			...Object.keys(reading.tables),
			...(directory === '*' ? [] : [directory]),
		]),
	].sort());
	const members = $derived(reading.documents.filter((doc) =>
		directory === '*' || doc.directory === (directory === '.' ? '' : directory),
	));
	let focusedPath = $state<string>();
	const projection = $derived(applyView(members, view, focusedPath));
	const included = $derived(new Set(applyView(members, view).documents.map((doc) => doc.path)));
	const documents = $derived(projection.documents);
	const availableColumns = $derived([
		...new Set(members.flatMap((doc) => [
			...Object.keys(doc.fields ?? {}),
			...Object.keys(tableFor(doc.path)?.properties ?? {}),
		]).concat(Object.keys(tableSchema()?.properties ?? {}))),
	].sort());
	const columns = $derived(view.columns ?? availableColumns);
	const rows = $derived(documents.map((doc) => ({
		doc,
		canEdit: !doc.issues?.some((issue) => issue.kind !== 'schema'),
	})));
	const lanes = $derived(view.type === 'board'
		? boardLanes(rows.map((row) => row.doc), view.groupBy, tableSchema())
		: []);
	const byPath = $derived(new Map(rows.map((row) => [row.doc.path, row])));
	let newCard = $state('');
	let newKind = $state('string');
	let newValue = $state('');
	let newNumber = $state<number | null>(null);

	function tableSchema() {
		return Object.hasOwn(reading.tables, directory) ? reading.tables[directory] : undefined;
	}
	function tableFor(path: string) {
		const parts = path.split('/');
		return parts.length === 2 && Object.hasOwn(reading.tables, parts[0]!)
			? reading.tables[parts[0]!]
			: undefined;
	}
	function update(path: string, column: string, value: unknown) {
		return folder.update(path, { fields: { [column]: value } }, { schema: tableFor(path) });
	}
	function createLane() {
		if (view.type !== 'board') return;
		const row = byPath.get(newCard);
		if (!row?.canEdit) return;
		const value = newKind === 'null' ? null
			: newKind === 'boolean' ? newValue === 'true'
			: newKind === 'number' ? newNumber : newValue;
		if (newKind === 'number' && (newNumber === null || !Number.isFinite(newNumber))) return;
		void update(row.doc.path, view.groupBy, value);
	}
	const fieldValue = (fields: Record<string, unknown> | undefined, column: string) =>
		fields !== undefined && Object.hasOwn(fields, column) ? fields[column] : undefined;
	const display = (value: unknown) => value === undefined ? ''
		: typeof value === 'string' ? value : JSON.stringify(value);
	function cellKind(path: string, column: string, value: unknown) {
		if (value !== undefined && value !== null) return typeof value;
		const schema = tableFor(path)?.properties[column];
		return typeof schema === 'object' && schema !== null && 'type' in schema
			? schema.type : 'string';
	}
	function focus(event: FocusEvent) {
		const target = event.target;
		if (target instanceof Element) focusedPath = target.closest('[data-row-path]')?.getAttribute('data-row-path') ?? undefined;
	}
	function blur() {
		queueMicrotask(() => {
			const active = document.activeElement;
			focusedPath = active?.closest('[data-row-path]')?.getAttribute('data-row-path') ?? undefined;
		});
	}
</script>

<section class="flex min-h-0 flex-1 flex-col gap-3 p-4" aria-label="Tables" onfocusin={focus} onfocusout={blur}>
	<div class="flex items-center gap-3">
		<label for="table-directory">Directory</label>
		<Select.Root type="single" value={directory} onValueChange={(table) => change({ ...view, table })}>
			<Select.Trigger id="table-directory">{directory === '*' ? 'All Markdown' : directory === '.' ? 'Folder root' : directory}</Select.Trigger>
			<Select.Content><Select.Group>
				<Select.Item value="*">All Markdown</Select.Item>
				{#each directories as name}<Select.Item value={name || '.'}>{name || 'Folder root'}</Select.Item>{/each}
			</Select.Group></Select.Content>
		</Select.Root>
		<div class="ml-auto flex gap-2">
			<Button variant={view.type === 'grid' ? 'secondary' : 'ghost'} onclick={() => {
				if (view.type === 'board') { const { groupBy: _, ...rest } = view; change({ ...rest, type: 'grid' }); }
			}}>Grid</Button>
			<Button variant={view.type === 'board' ? 'secondary' : 'ghost'} onclick={() => change({
				...view, type: 'board', groupBy: view.type === 'board' ? view.groupBy : (availableColumns[0] ?? 'status'),
			})}>Board</Button>
		</div>
	</div>
	{#if view.type === 'board'}
		<label class="flex items-center gap-3 text-sm">Group by
			<Input aria-label="Group by" value={view.groupBy} oninput={(event) =>
				view.type === 'board' && change({ ...view, groupBy: event.currentTarget.value })} class="w-64" />
		</label>
	{/if}
	<TableControls {view} columns={availableColumns} {change} />
	<p class="text-sm text-muted-foreground">Edits save when you pause. Filters and sorting read saved values. Open a file to edit its source.</p>
	{#each projection.problems as problem}<p class="text-sm text-destructive">{problem}</p>{/each}
	{#if reading.declarationProblem}
		<Alert.Root variant="destructive"><Alert.Description>
			Could not use the declared schemas: {reading.declarationProblem}
			<Button variant="link" onclick={() => openSource('epicenter.json')}>Open epicenter.json</Button>
		</Alert.Description></Alert.Root>
	{/if}
	{#each reading.unreadable as issue}<p class="text-sm text-destructive">{issue.path}: {issue.message} <Button size="xs" variant="outline" onclick={() => folder.checkpoint()}>Try again</Button></p>{/each}
	{#if documents.length === 0}
		<p class="text-muted-foreground">{projection.problems.length ? 'Fix the filter above to see matching files.' : members.length ? 'No files match these filters.' : 'No Markdown files in this directory.'}</p>
	{:else if view.type === 'board'}
		<div class="flex min-h-0 gap-4 overflow-auto pb-3" aria-label="Board">
			{#each lanes as lane (lane.key)}
				<section class="w-72 shrink-0" aria-label={lane.label}>
					<h3 class="mb-2 text-sm font-semibold">{lane.label} <span class="text-muted-foreground">{lane.documents.length}</span></h3>
					<div class="flex flex-col gap-2">
						{#each lane.documents as doc (doc.path)}
							{@const row = byPath.get(doc.path)!}
							<article class="rounded-md border p-3" data-row-path={doc.path}>
								<Button variant="link" onclick={() => openSource(doc.path)}>{typeof doc.fields?.title === 'string' ? doc.fields.title : doc.stem}</Button>
								<p class="mb-2 truncate text-xs text-muted-foreground">{doc.path}</p>
								{#if !included.has(doc.path)}<p class="text-xs text-muted-foreground">No longer matches this view's filters</p>{/if}
								{#each columns.filter((column) => column !== view.groupBy && column !== 'title') as column}
									<p class="truncate text-sm"><span class="text-muted-foreground">{column}: </span>{display(fieldValue(doc.fields, column))}</p>
								{/each}
								<BoardMove path={doc.path} {lane} {lanes} disabled={!row.canEdit} save={(key) => {
									const destination = lanes.find((entry) => entry.key === key);
									return view.type === 'board' && destination?.editable ? update(doc.path, view.groupBy, destination.value) : undefined;
								}} />
								{#each doc.issues ?? [] as issue}<p class="text-xs text-destructive">{issue.message}</p>{/each}
							</article>
						{/each}
					</div>
				</section>
			{/each}
		</div>
		<details><summary class="cursor-pointer text-sm">Move a card to a new value</summary>
			<div class="flex flex-wrap items-center gap-2 pt-2">
				<Select.Root type="single" bind:value={newCard}><Select.Trigger aria-label="Card to move">{newCard || 'Choose a card'}</Select.Trigger><Select.Content>{#each rows.filter((row) => row.canEdit) as row}<Select.Item value={row.doc.path}>{row.doc.path}</Select.Item>{/each}</Select.Content></Select.Root>
				<Select.Root type="single" value={newKind} onValueChange={(kind) => { newKind = kind; newValue = kind === 'boolean' ? 'false' : ''; newNumber = null; }}><Select.Trigger aria-label="New value type">{newKind}</Select.Trigger><Select.Content>{#each ['string', 'number', 'boolean', 'null'] as kind}<Select.Item value={kind}>{kind}</Select.Item>{/each}</Select.Content></Select.Root>
				{#if newKind === 'boolean'}<Select.Root type="single" bind:value={newValue}><Select.Trigger aria-label="New group value">{newValue || 'false'}</Select.Trigger><Select.Content><Select.Item value="true">true</Select.Item><Select.Item value="false">false</Select.Item></Select.Content></Select.Root>
				{:else if newKind === 'number'}<Input aria-label="New group value" bind:value={newNumber} type="number" class="w-48" />
				{:else if newKind !== 'null'}<Input aria-label="New group value" bind:value={newValue} type="text" class="w-48" />{/if}
				<Button disabled={!newCard || (newKind === 'number' && (newNumber === null || !Number.isFinite(newNumber)))} onclick={createLane}>Move card</Button>
			</div>
		</details>
	{:else}
		<Table.Root><Table.Header><Table.Row><Table.Head>File</Table.Head>{#each columns as column}<Table.Head>{column}</Table.Head>{/each}<Table.Head>Issues</Table.Head></Table.Row></Table.Header>
			<Table.Body>
				{#each rows as row (row.doc.path)}
					{@const { doc, canEdit } = row}
					<Table.Row data-row-path={doc.path}>
						<Table.Cell><Button variant="link" onclick={() => openSource(doc.path)}>{doc.path}</Button>{#if !included.has(doc.path)}<p class="text-xs text-muted-foreground">No longer matches this view's filters</p>{/if}</Table.Cell>
						{#each columns as column (column)}
							<Table.Cell>
								{@const value = fieldValue(doc.fields, column)}
								{@const kind = cellKind(doc.path, column, value)}
								{#if kind === 'boolean'}
									<BooleanCell {value} label="{doc.path}: {column}" disabled={!canEdit} save={(next) => update(doc.path, column, next)} />
								{:else if kind === 'string' || kind === 'number' || kind === 'integer'}
									<FieldCell {value} {kind} label="{doc.path}: {column}" disabled={!canEdit} save={(next) => update(doc.path, column, next)} />
								{:else}<span class="font-mono text-xs">{display(value)}</span>{/if}
							</Table.Cell>
						{/each}
						<Table.Cell>{#each doc.issues ?? [] as issue}<p class="text-xs text-destructive">{issue.message}</p>{/each}</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	{/if}
</section>
