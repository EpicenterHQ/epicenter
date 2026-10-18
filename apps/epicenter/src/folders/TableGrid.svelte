<script lang="ts">
	import type { PreparedFolderTable } from '@epicenter/folder';
	import type { TableOptions, TableWrites } from '@epicenter/folder/query';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { createQuery } from '@tanstack/svelte-query';
	import FieldEditor from './FieldEditor.svelte';
	import { columnsOf, displayOf } from './field-input';
	import RowBody from './RowBody.svelte';

	/**
	 * One table of an opened folder: a grid of its rows, one column per
	 * declared field, and a side panel for the selected row with its body.
	 * The rows are the cache's (`list`), which the folder's change channel
	 * keeps fresh. Each field editor sets its field on the row's file as it
	 * is now; the body is saved as the change from the row it started from
	 * (ADR-0576). An edit of a row another window deleted writes nothing, so
	 * its text is kept here, to copy, until the person dismisses it.
	 */
	let {
		name,
		table,
		options,
		writes,
	}: {
		name: string;
		table: PreparedFolderTable;
		options: TableOptions<Record<string, unknown>>;
		/** The table's writes, each in its row's turn. */
		writes: TableWrites<Record<string, unknown>>;
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

	/** Text typed into rows deleted elsewhere, which no file holds. */
	let lost = $state<{ readonly id: number; readonly where: string; readonly text: string }[]>([]);
	let lostCount = 0;
	/** Keep `text`, typed into `where` of a row deleted elsewhere, for the person to copy. */
	function keepLost(where: string, text: string) {
		lost = [...lost, { id: ++lostCount, where, text }];
	}
	const dismiss = (id: number) => (lost = lost.filter((item) => item.id !== id));

</script>

{#if listing.error}
	<div class="border-b px-4 py-2">
		<Alert.Root variant="destructive">
			<Alert.Description>{listing.error.message}</Alert.Description>
		</Alert.Root>
	</div>
{/if}
{#each lost as item (item.id)}
	<div class="border-b px-4 py-2">
		<Alert.Root variant="destructive">
			<Alert.Title>This row was deleted or no longer reads as a row, so your edit to {item.where} was not saved.</Alert.Title>
			<Alert.Description>
				<pre class="max-h-32 w-full overflow-auto font-mono text-xs whitespace-pre-wrap">{item.text}</pre>
				<div class="flex gap-2">
					<Button size="xs" variant="outline" onclick={() => void navigator.clipboard.writeText(item.text).catch(() => {})}>Copy your text</Button>
					<Button size="xs" variant="ghost" onclick={() => dismiss(item.id)}>Dismiss</Button>
				</div>
			</Alert.Description>
		</Alert.Root>
	</div>
{/each}
<div class="flex min-h-0 flex-1">
	<div class="min-h-0 flex-1 overflow-auto">
		{#if rows === undefined}
			<p class="p-4 text-sm text-muted-foreground">
				{listing.isPending ? 'Reading…' : ''}
			</p>
		{:else if rows.length === 0}
			<p class="p-4 text-sm text-muted-foreground">No rows in this table.</p>
		{:else}
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
								</td>
								{#if stored !== undefined}
									{#each columns as column (column.name)}
										<td class="px-2 py-1.5">
											<FieldEditor
												{column}
												stem={item.stem}
												{writes}
												onlost={keepLost}
												value={Object.hasOwn(stored.row.fields, column.name)
													? stored.row.fields[column.name]
													: undefined}
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
				<div class="flex flex-col gap-3 p-4">
					{#key selected.stem}
						{#each columns as column (column.name)}
							<div class="flex flex-col gap-1">
								<span class="text-xs font-medium text-muted-foreground">{column.name}</span>
								<FieldEditor
									{column}
									stem={selected.stem}
									{writes}
									onlost={keepLost}
									multiline
									value={Object.hasOwn(stored.row.fields, column.name)
										? stored.row.fields[column.name]
										: undefined}
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
					{#key selected.stem}
						<RowBody stem={selected.stem} {stored} {options} {writes} onlost={keepLost} />
					{/key}
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
