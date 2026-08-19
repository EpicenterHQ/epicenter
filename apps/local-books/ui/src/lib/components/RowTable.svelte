<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import * as Table from '@epicenter/ui/table';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { formatCell, numberFmt } from '$lib/format';
	import type { TableRowsPage } from '$lib/types';

	let {
		page,
		loading,
		error,
		selectedId,
		onSelect,
	}: {
		page: TableRowsPage | undefined;
		loading: boolean;
		error: string | null;
		selectedId: string | null;
		onSelect: (id: string) => void;
	} = $props();

	const columns = $derived(page?.columns ?? []);
	const rows = $derived(page?.rows ?? []);
	const pk = $derived(page?.pk ?? null);

	// The row's address, when the table has a single-column primary key. Without
	// one there is nothing stable to select or fetch a detail by.
	function rowKey(row: Record<string, unknown>): string | null {
		if (pk === null) return null;
		const value = row[pk];
		return value === null || value === undefined ? null : String(value);
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div
		class="flex h-9 shrink-0 items-center justify-between border-b border-border px-3 text-xs text-muted-foreground"
	>
		{#if page}
			<span class="font-mono">{page.table}</span>
			<span class="tabular-nums">
				{numberFmt.format(rows.length)} of {numberFmt.format(page.total)} rows
			</span>
		{/if}
	</div>

	<div class="min-h-0 flex-1 overflow-auto">
		{#if error}
			<Empty.Root class="h-full border-0">
				<Empty.Media variant="icon">
					<TriangleAlertIcon class="size-5 text-destructive" />
				</Empty.Media>
				<Empty.Title>Could not load rows</Empty.Title>
				<Empty.Description>{error}</Empty.Description>
			</Empty.Root>
		{:else if loading}
			<Loading class="h-full" label="Loading rows" />
		{:else if rows.length === 0}
			<Empty.Root class="h-full border-0">
				<Empty.Media variant="icon">
					<DatabaseIcon class="size-5" />
				</Empty.Media>
				<Empty.Title>No rows</Empty.Title>
				<Empty.Description>This table may not be synced yet.</Empty.Description>
			</Empty.Root>
		{:else}
			<Table.Root class="text-sm">
				<Table.Header>
					<Table.Row>
						{#each columns as column (column.name)}
							<Table.Head
								class="font-mono text-xs {column.type === 'REAL' ? 'text-right' : ''}"
							>
								{column.name}
							</Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each rows as row, index (rowKey(row) ?? index)}
						{@const key = rowKey(row)}
						<Table.Row
							class="{key !== null ? 'cursor-pointer' : ''} {selectedId !== null && selectedId === key ? 'bg-muted' : ''} {row.deleted === 1 ? 'text-muted-foreground line-through' : ''}"
							onclick={() => {
								if (key !== null) onSelect(key);
							}}
						>
							{#each columns as column (column.name)}
								<Table.Cell
									class="max-w-64 truncate {column.type === 'REAL' ? 'text-right tabular-nums' : ''}"
								>
									{formatCell(row[column.name], column)}
								</Table.Cell>
							{/each}
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</div>
</div>
