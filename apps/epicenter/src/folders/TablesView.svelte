<script lang="ts">
	import { getFolder } from './context.js';
	import { readDocument, readDocuments } from '@epicenter/folder/documents';
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Select from '@epicenter/ui/select';
	import * as Table from '@epicenter/ui/table';
	import * as Alert from '@epicenter/ui/alert';
	import { createQuery } from '@tanstack/svelte-query';
	import type { FileDrafts } from './drafts.svelte';
	import { fileText, savedText } from './files';
	import { applyView, boardLanes } from './view';
	import TableControls from './TableControls.svelte';
	import type { TableView } from './views.svelte';

	let {
		drafts,
		openSource,
		view,
		change,
	}: {
		drafts: FileDrafts;
		openSource: (path: string) => void;
		view: TableView;
		change: (value: TableView) => void;
	} = $props();
	const context = getFolder();
	const reading = createQuery(() => ({
		queryKey: [...context.queries.key, 'documents'],
		queryFn: async () => {
			const result = await readDocuments(context.folder.files);
			if (result.error !== null) throw result.error;
			return result.data;
		},
	}));
	const directory = $derived(view.table);
	const directories = $derived(
		[
			...new Set([
				...(reading.data?.documents.map((doc) => doc.directory) ?? []),
				...Object.keys(reading.data?.tables ?? {}),
				...(directory === '*' ? [] : [directory]),
			]),
		].sort(),
	);
	const members = $derived(
		(reading.data?.documents ?? []).filter(
			(doc) =>
				directory === '*' ||
				doc.directory === (directory === '.' ? '' : directory),
		),
	);
	const projection = $derived(applyView(members, view));
	const included = $derived(
		new Set(projection.documents.map((doc) => doc.path)),
	);
	const documents = $derived([
		...projection.documents,
		...members.filter(
			(doc) => !included.has(doc.path) && drafts.file(doc.path).held,
		),
	]);
	const availableColumns = $derived(
		[
			...new Set(
				members
					.flatMap((doc) => [
						...Object.keys(doc.fields),
						...Object.keys(tableFor(doc.path)?.properties ?? {}),
					])
					.concat(Object.keys(tableSchema()?.properties ?? {})),
			),
		].sort(),
	);
	const columns = $derived(view.columns ?? availableColumns);
	const rows = $derived(
		documents.map((doc) => {
			const draft = drafts.file(doc.path);
			const source = fileText(doc.content);
			const base =
				source.kind === 'text'
					? { content: doc.content, crlf: source.crlf }
					: undefined;
			const text = draft.shown(base);
			const shown =
				text === undefined
					? doc
					: readDocument(
							doc.path,
							new TextEncoder().encode(savedText(text, base?.crlf ?? false)),
							tableFor(doc.path),
						);
			return {
				doc,
				draft,
				base,
				shown,
				locked:
					base === undefined ||
					!!shown.issues?.some((issue) => issue.kind !== 'schema') ||
					draft.sourceLocked,
			};
		}),
	);
	const lanes = $derived(
		view.type === 'board'
			? boardLanes(
					rows.map((row) => row.shown),
					view.groupBy,
					tableSchema(),
				)
			: [],
	);
	const byPath = $derived(new Map(rows.map((row) => [row.doc.path, row])));
	let newCard = $state('');
	let newKind = $state('string');
	let newValue = $state('');
	function createLane() {
		if (view.type !== 'board') return;
		const row = byPath.get(newCard);
		if (!row || row.locked || !row.base) return;
		const value =
			newKind === 'null'
				? null
				: newKind === 'boolean'
					? newValue === 'true'
					: newKind === 'number'
						? Number(newValue)
						: newValue;
		if (newKind === 'number' && (newValue === '' || !Number.isFinite(value)))
			return;
		row.draft.change({ [view.groupBy]: value }, row.base);
	}
	function tableSchema() {
		return Object.hasOwn(reading.data?.tables ?? {}, directory)
			? reading.data?.tables[directory]
			: undefined;
	}
	function tableFor(path: string) {
		const parts = path.split('/');
		return parts.length === 2 &&
			Object.hasOwn(reading.data?.tables ?? {}, parts[0]!)
			? reading.data?.tables[parts[0]!]
			: undefined;
	}
	const fieldValue = (fields: Record<string, unknown>, column: string) =>
		Object.hasOwn(fields, column) ? fields[column] : undefined;
	const display = (value: unknown) =>
		value === undefined
			? ''
			: typeof value === 'string'
				? value
				: JSON.stringify(value);
	function cellKind(path: string, column: string, value: unknown) {
		if (value !== undefined && value !== null) return typeof value;
		const schema = tableFor(path)?.properties[column];
		return typeof schema === 'object' && schema !== null && 'type' in schema
			? schema.type
			: 'string';
	}
</script>

<section class="flex min-h-0 flex-1 flex-col gap-3 p-4" aria-label="Tables">
	<div class="flex items-center gap-3">
		<label for="table-directory">Directory</label>
		<Select.Root
			type="single"
			value={directory}
			onValueChange={(table) => change({ ...view, table })}
		>
			<Select.Trigger id="table-directory"
				>{directory === '*'
					? 'All Markdown'
					: directory === '.'
						? 'Folder root'
						: directory}</Select.Trigger
			>
			<Select.Content
				><Select.Group
					><Select.Item value="*">All Markdown</Select.Item
					>{#each directories as name}<Select.Item value={name || '.'}
							>{name || 'Folder root'}</Select.Item
						>{/each}</Select.Group
				></Select.Content
			>
		</Select.Root>
		<div class="ml-auto flex gap-2">
			<Button
				variant={view.type === 'grid' ? 'secondary' : 'ghost'}
				onclick={() => {
					if (view.type === 'board') {
						const { groupBy: _, ...rest } = view;
						change({ ...rest, type: 'grid' });
					}
				}}>Grid</Button
			><Button
				variant={view.type === 'board' ? 'secondary' : 'ghost'}
				onclick={() =>
					change({
						...view,
						type: 'board',
						groupBy:
							view.type === 'board'
								? view.groupBy
								: (availableColumns[0] ?? 'status'),
					})}>Board</Button
			>
		</div>
	</div>
	{#if view.type === 'board'}<label class="flex items-center gap-3 text-sm"
			>Group by<Input
				aria-label="Group by"
				value={view.groupBy}
				oninput={(event) =>
					view.type === 'board' &&
					change({ ...view, groupBy: event.currentTarget.value })}
				class="w-64"
			/></label
		>{/if}
	<TableControls {view} columns={availableColumns} {change} />
	<p class="text-sm text-muted-foreground">
		Edits save when you pause. Filters and sorting read saved values. Open a
		file to edit its source.
	</p>
	{#each projection.problems as problem}<p class="text-sm text-destructive">
			{problem}
		</p>{/each}
	{#if reading.error}
		<Alert.Root variant="destructive"
			><Alert.Description>{reading.error.message}</Alert.Description
			></Alert.Root
		>
	{:else if reading.isPending}
		<p role="status">Reading…</p>
	{:else if reading.data}
		{#if reading.data.declarationProblem}
			<Alert.Root variant="destructive"
				><Alert.Description
					>Could not use the declared schemas: {reading.data.declarationProblem}
					<Button variant="link" onclick={() => openSource('epicenter.json')}
						>Open epicenter.json</Button
					></Alert.Description
				></Alert.Root
			>
		{/if}
		{#each reading.data.unreadable as issue}<p class="text-sm text-destructive">
				{issue.path}: {issue.message}
			</p>{/each}
		{#if documents.length === 0}<p class="text-muted-foreground">
				{projection.problems.length
					? 'Fix the filter above to see matching files.'
					: members.length
						? 'No files match these filters.'
						: 'No Markdown files in this directory.'}
			</p>
		{:else if view.type === 'board'}
			<div class="flex min-h-0 gap-4 overflow-auto pb-3" aria-label="Board">
				{#each lanes as lane (lane.key)}
					<section class="w-72 shrink-0" aria-label={lane.label}>
						<h3 class="mb-2 text-sm font-semibold">
							{lane.label}
							<span class="text-muted-foreground">{lane.documents.length}</span>
						</h3>
						<div class="flex flex-col gap-2">
							{#each lane.documents as doc (doc.path)}
								{@const row = byPath.get(doc.path)!}
								<article class="rounded-md border p-3">
									<Button variant="link" onclick={() => openSource(doc.path)}
										>{typeof doc.fields.title === 'string' &&
										Object.hasOwn(doc.fields, 'title')
											? doc.fields.title
											: doc.stem}{row.draft.held ? ' •' : ''}</Button
									>
									<p class="mb-2 truncate text-xs text-muted-foreground">
										{doc.path}
									</p>
									{#if !included.has(doc.path)}<p
											class="text-xs text-muted-foreground"
										>
											Unsaved edit outside the filter
										</p>{/if}
									{#each columns.filter((column) => view.type === 'board' && column !== view.groupBy && column !== 'title') as column}<p
											class="truncate text-sm"
										>
											<span class="text-muted-foreground"
												>{column}:
											</span>{display(fieldValue(doc.fields, column))}
										</p>{/each}
									<Select.Root
										type="single"
										value={lane.key}
										onValueChange={(key) => {
											const destination = lanes.find(
												(entry) => entry.key === key,
											);
											if (
												view.type === 'board' &&
												destination?.editable &&
												row.base
											)
												row.draft.change(
													{ [view.groupBy]: destination.value },
													row.base,
												);
										}}
										><Select.Trigger
											aria-label="Move {doc.path}"
											disabled={row.locked}>{lane.label}</Select.Trigger
										><Select.Content
											>{#each lanes.filter((entry) => entry.editable) as destination}<Select.Item
													value={destination.key}
													>{destination.label}</Select.Item
												>{/each}</Select.Content
										></Select.Root
									>
									{#if row.draft.error}<p class="text-sm text-destructive">
											{row.draft.error.message}
										</p>
										<Button
											size="xs"
											variant="outline"
											onclick={() => void row.draft.retry()}>Try again</Button
										><Button
											size="xs"
											variant="ghost"
											onclick={() => row.draft.discard()}>Discard edit</Button
										>{/if}
									{#each doc.issues ?? [] as issue}<p
											class="text-xs text-destructive"
										>
											{issue.message}
										</p>{/each}
								</article>
							{/each}
						</div>
					</section>
				{/each}
			</div>
			<details>
				<summary class="cursor-pointer text-sm"
					>Move a card to a new value</summary
				>
				<div class="flex flex-wrap items-center gap-2 pt-2">
					<Select.Root type="single" bind:value={newCard}
						><Select.Trigger aria-label="Card to move"
							>{newCard || 'Choose a card'}</Select.Trigger
						><Select.Content
							>{#each rows.filter((row) => !row.locked) as row}<Select.Item
									value={row.doc.path}>{row.doc.path}</Select.Item
								>{/each}</Select.Content
						></Select.Root
					>
					<Select.Root
						type="single"
						value={newKind}
						onValueChange={(kind) => {
							newKind = kind;
							newValue = kind === 'boolean' ? 'false' : '';
						}}
						><Select.Trigger aria-label="New value type"
							>{newKind}</Select.Trigger
						><Select.Content
							>{#each ['string', 'number', 'boolean', 'null'] as kind}<Select.Item
									value={kind}>{kind}</Select.Item
								>{/each}</Select.Content
						></Select.Root
					>
					{#if newKind === 'boolean'}<Select.Root
							type="single"
							bind:value={newValue}
							><Select.Trigger aria-label="New group value"
								>{newValue || 'false'}</Select.Trigger
							><Select.Content
								><Select.Item value="true">true</Select.Item><Select.Item
									value="false">false</Select.Item
								></Select.Content
							></Select.Root
						>{:else if newKind !== 'null'}<Input
							aria-label="New group value"
							bind:value={newValue}
							type={newKind === 'number' ? 'number' : 'text'}
							class="w-48"
						/>{/if}
					<Button
						disabled={!newCard ||
							(newKind === 'number' &&
								(newValue === '' || !Number.isFinite(Number(newValue))))}
						onclick={createLane}>Move card</Button
					>
				</div>
			</details>
		{:else}
			<Table.Root>
				<Table.Header
					><Table.Row
						><Table.Head>File</Table.Head>{#each columns as column}<Table.Head
								>{column}</Table.Head
							>{/each}<Table.Head>Issues</Table.Head></Table.Row
					></Table.Header
				>
				<Table.Body>
					{#each rows as row (row.doc.path)}
						{@const { doc, draft, base, shown, locked } = row}
						<Table.Row>
							<Table.Cell
								><Button variant="link" onclick={() => openSource(doc.path)}
									>{doc.path}{draft.held ? ' •' : ''}</Button
								>{#if !included.has(doc.path)}<p
										class="text-xs text-muted-foreground"
									>
										Unsaved edit outside the filter
									</p>{/if}</Table.Cell
							>
							{#each columns as column}
								<Table.Cell>
									{@const kind = cellKind(
										doc.path,
										column,
										fieldValue(shown.fields, column),
									)}
									{#if kind === 'boolean'}
										<Checkbox
											aria-label="{doc.path}: {column}"
											disabled={locked}
											bind:checked={
												() => fieldValue(shown.fields, column) === true,
												(value) =>
													base && draft.change({ [column]: value }, base)
											}
										/>
									{:else if kind === 'string' || kind === 'number' || kind === 'integer'}
										<Input
											aria-label="{doc.path}: {column}"
											disabled={locked}
											type={kind === 'number' || kind === 'integer'
												? 'number'
												: 'text'}
											bind:value={
												() => display(fieldValue(shown.fields, column)),
												(value) => {
													if (
														!base ||
														((kind === 'number' || kind === 'integer') &&
															(value == null ||
																String(value) === '' ||
																!Number.isFinite(Number(value))))
													)
														return;
													draft.change(
														{
															[column]:
																kind === 'number' || kind === 'integer'
																	? Number(value)
																	: String(value ?? ''),
														},
														base,
													);
												}
											}
											onblur={() => void draft.save()}
										/>
									{:else}<span class="font-mono text-xs"
											>{display(fieldValue(shown.fields, column))}</span
										>{/if}
								</Table.Cell>
							{/each}
							<Table.Cell>
								{#if draft.error}<p class="text-destructive">
										{draft.error.message}
									</p>
									<Button
										size="xs"
										variant="outline"
										onclick={() => void draft.retry()}>Try again</Button
									><Button
										size="xs"
										variant="ghost"
										onclick={() => draft.discard()}>Discard edit</Button
									>{/if}
								{#each shown.issues ?? [] as issue}<p
										class="text-xs text-destructive"
									>
										{issue.message}
									</p>{/each}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	{/if}
</section>
