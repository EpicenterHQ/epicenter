<script lang="ts">
	import { getFolder } from '@epicenter/svelte/folder';
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

	let { drafts, openSource }: { drafts: FileDrafts; openSource: (path: string) => void } = $props();
	const context = getFolder<Record<never, never>>();
	const reading = createQuery(() => ({
		queryKey: [...context.queries.key, 'documents'],
		queryFn: async () => {
			const result = await readDocuments(context.folder.files);
			if (result.error !== null) throw result.error;
			return result.data;
		},
	}));
	let directory = $state('*');
	const directories = $derived([...new Set(reading.data?.documents.map((doc) => doc.directory) ?? [])].sort());
	const documents = $derived((reading.data?.documents ?? []).filter((doc) => directory === '*' || doc.directory === (directory === '.' ? '' : directory)));
	const columns = $derived([...new Set(documents.flatMap((doc) => [...Object.keys(doc.fields), ...Object.keys(tableFor(doc.path)?.properties ?? {})]))].sort());
	function tableFor(path: string) { const parts = path.split('/'); return parts.length === 2 && Object.hasOwn(reading.data?.tables ?? {}, parts[0]!) ? reading.data?.tables[parts[0]!] : undefined; }
	const fieldValue = (fields: Record<string, unknown>, column: string) => Object.hasOwn(fields, column) ? fields[column] : undefined;
	const display = (value: unknown) => value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
	function cellKind(path: string, column: string, value: unknown) {
		if (value !== undefined && value !== null) return typeof value;
		const schema = tableFor(path)?.properties[column];
		return typeof schema === 'object' && schema !== null && 'type' in schema ? schema.type : 'string';
	}
</script>

<section class="flex min-h-0 flex-1 flex-col gap-3 p-4" aria-label="Tables">
	<div class="flex items-center gap-3">
		<label for="table-directory">Directory</label>
		<Select.Root type="single" bind:value={directory}>
			<Select.Trigger id="table-directory">{directory === '*' ? 'All Markdown' : directory === '.' ? 'Folder root' : directory}</Select.Trigger>
			<Select.Content><Select.Group><Select.Item value="*">All Markdown</Select.Item>{#each directories as name}<Select.Item value={name || '.'}>{name || 'Folder root'}</Select.Item>{/each}</Select.Group></Select.Content>
		</Select.Root>
		<p class="text-sm text-muted-foreground">Cells save when you pause. Open a file to edit its full source.</p>
	</div>
	{#if reading.error}
		<Alert.Root variant="destructive"><Alert.Description>{reading.error.message}</Alert.Description></Alert.Root>
	{:else if reading.isPending}
		<p role="status">Reading…</p>
	{:else if reading.data}
		{#if reading.data.declarationProblem}
			<Alert.Root variant="destructive"><Alert.Description>Could not use the declared schemas: {reading.data.declarationProblem} <Button variant="link" onclick={() => openSource('epicenter.json')}>Open epicenter.json</Button></Alert.Description></Alert.Root>
		{/if}
		{#each reading.data.unreadable as issue}<p class="text-sm text-destructive">{issue.path}: {issue.message}</p>{/each}
		{#if documents.length === 0}<p class="text-muted-foreground">No Markdown files in this directory.</p>
		{:else}
			<Table.Root>
				<Table.Header><Table.Row><Table.Head>File</Table.Head>{#each columns as column}<Table.Head>{column}</Table.Head>{/each}<Table.Head>Issues</Table.Head></Table.Row></Table.Header>
				<Table.Body>
					{#each documents as doc (doc.path)}
						{@const draft = drafts.file(doc.path)}
						{@const source = fileText(doc.content)}
						{@const base = source.kind === 'text' ? { content: doc.content, crlf: source.crlf } : undefined}
						{@const text = draft.shown(base)}
						{@const shown = text === undefined ? doc : readDocument(doc.path, new TextEncoder().encode(savedText(text, base?.crlf ?? false)), tableFor(doc.path))}
						{@const locked = base === undefined || shown.issues?.some((issue) => issue.kind !== 'schema') || draft.sourceLocked}
						<Table.Row>
							<Table.Cell><Button variant="link" onclick={() => openSource(doc.path)}>{doc.path}{draft.held ? ' •' : ''}</Button></Table.Cell>
							{#each columns as column}
								<Table.Cell>
									{@const kind = cellKind(doc.path, column, fieldValue(shown.fields, column))}
									{#if kind === 'boolean'}
										<Checkbox aria-label="{doc.path}: {column}" disabled={locked} bind:checked={() => fieldValue(shown.fields, column) === true, (value) => base && draft.change({ [column]: value }, base)} />
									{:else if kind === 'string' || kind === 'number' || kind === 'integer'}
										<Input aria-label="{doc.path}: {column}" disabled={locked} type={kind === 'number' || kind === 'integer' ? 'number' : 'text'} bind:value={() => display(fieldValue(shown.fields, column)), (value) => { if (!base || ((kind === 'number' || kind === 'integer') && (value == null || String(value) === '' || !Number.isFinite(Number(value))))) return; draft.change({ [column]: kind === 'number' || kind === 'integer' ? Number(value) : String(value ?? '') }, base); }} onblur={() => void draft.save()} />
									{:else}<span class="font-mono text-xs">{display(fieldValue(shown.fields, column))}</span>{/if}
								</Table.Cell>
							{/each}
							<Table.Cell>
								{#if draft.error}<p class="text-destructive">{draft.error.message}</p><Button size="xs" variant="outline" onclick={() => void draft.retry()}>Try again</Button><Button size="xs" variant="ghost" onclick={() => draft.discard()}>Discard edit</Button>{/if}
								{#each shown.issues ?? [] as issue}<p class="text-xs text-destructive">{issue.message}</p>{/each}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	{/if}
</section>
