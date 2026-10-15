<script lang="ts">
	import type { PreparedFolderTable } from '@epicenter/folder';
	import type { TableOptions } from '@epicenter/folder/query';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { createQuery } from '@tanstack/svelte-query';
	import FieldEditor from './FieldEditor.svelte';
	import {
		applyFieldChange,
		columnsOf,
		displayOf,
		type FieldChange,
	} from './field-input';
	import type { RowEdits, StoredAnyRow } from './row-edits.svelte';

	/**
	 * One table of an opened folder: a grid of its rows, one column per
	 * declared field, and a side panel for the selected row with its body.
	 * The rows are the cache's (`list`), which the folder's change channel
	 * keeps fresh; every edit goes through `edits`.
	 */
	let {
		name,
		table,
		options,
		edits,
	}: {
		name: string;
		table: PreparedFolderTable;
		options: TableOptions<Record<string, unknown>>;
		edits: RowEdits;
	} = $props();

	const listing = createQuery(() => options.list.queryOptions());
	const rows = $derived(
		listing.data &&
			[...listing.data].sort((a, b) =>
				a.stem.localeCompare(b.stem, undefined, { numeric: true }),
			),
	);
	const columns = $derived(columnsOf(table));
	let selectedStem = $state<string | undefined>(undefined);
	const selected = $derived(rows?.find((item) => item.stem === selectedStem));

	const changeField = (
		stem: string,
		stored: StoredAnyRow,
		field: string,
		change: FieldChange,
	) =>
		edits.commit(name, stem, stored, (row) =>
			applyFieldChange(row.fields, field, change),
		);

	let bodyBox = $state<HTMLTextAreaElement | undefined>();
	/** The body the box shows when typing begins: what an edit is measured from. */
	let bodyShown = '';
	/** Whether the person typed since the box last showed the stored body. */
	let bodyTyping = false;
	const storedBody = $derived(
		selected?.result.error === null ? selected.result.data.row.body : '',
	);
	// The box follows the stored body until the person types in it.
	$effect(() => {
		const text = storedBody;
		edits.resets;
		if (bodyBox !== undefined && !bodyTyping) {
			bodyShown = text;
			bodyBox.value = text;
		}
	});
</script>

{#if listing.error}
	<div class="border-b px-4 py-2">
		<Alert.Root variant="destructive">
			<Alert.Description>{listing.error.message}</Alert.Description>
		</Alert.Root>
	</div>
{/if}
<div class="flex min-h-0 flex-1">
	<div class="min-h-0 flex-1 overflow-auto">
		{#if rows === undefined}
			<p class="p-4 text-sm text-muted-foreground">
				{listing.isPending ? 'Reading…' : ''}
			</p>
		{:else if rows.length === 0}
			<p class="p-4 text-sm text-muted-foreground">No rows in this table.</p>
		{:else}
			{#key edits.resets}
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
							{@const stored = item.result.error === null ? item.result.data : undefined}
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
									{#if edits.changedElsewhere(name, item.stem, stored)}
										<p class="mt-1 text-xs text-muted-foreground" role="status">
											Changed elsewhere; your edit will be merged
										</p>
									{/if}
								</td>
								{#if stored !== undefined}
									{#each columns as column (column.name)}
										<td class="px-2 py-1.5">
											<FieldEditor
												{column}
												value={Object.hasOwn(stored.row.fields, column.name)
													? stored.row.fields[column.name]
													: undefined}
												begin={() => edits.begin(name, item.stem, stored)}
												commit={(change) =>
													changeField(item.stem, stored, column.name, change)}
												revert={() => edits.revert(name, item.stem)}
											/>
										</td>
									{/each}
								{:else if item.result.error !== null}
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
					{#if edits.changedElsewhere(name, stem, stored)}
						<p class="text-xs text-muted-foreground" role="status">
							Changed elsewhere; your edit will be merged
						</p>
					{/if}
					{#key edits.resets}
						{#each columns as column (column.name)}
							<div class="flex flex-col gap-1">
								<span class="text-xs font-medium text-muted-foreground">{column.name}</span>
								<FieldEditor
									{column}
									multiline
									value={Object.hasOwn(stored.row.fields, column.name)
										? stored.row.fields[column.name]
										: undefined}
									begin={() => edits.begin(name, stem, stored)}
									commit={(change) => changeField(stem, stored, column.name, change)}
									revert={() => edits.revert(name, stem)}
								/>
							</div>
						{/each}
					{/key}
					{#each Object.keys(stored.row.fields).filter((key) => !Object.hasOwn(table.fields, key)) as extra (extra)}
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
							oninput={() => {
								if (bodyTyping) return;
								bodyTyping = true;
								edits.begin(name, stem, stored);
							}}
							onblur={(event) => {
								if (!bodyTyping) return;
								bodyTyping = false;
								const text = event.currentTarget.value;
								if (text === bodyShown) {
									edits.revert(name, stem);
									event.currentTarget.value = storedBody;
									bodyShown = storedBody;
									return;
								}
								edits.commit(name, stem, stored, (row) => {
									row.body = text;
								});
							}}
						></textarea>
						<span class="text-xs text-muted-foreground">Saved when you leave the box.</span>
					</label>
				</div>
			{:else if selected.result.error.name === 'InvalidRow'}
				{@const invalid = selected.result.error}
				<div class="flex flex-col gap-3 p-4">
					<p class="text-sm">This row does not read as a row of {name}:</p>
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
