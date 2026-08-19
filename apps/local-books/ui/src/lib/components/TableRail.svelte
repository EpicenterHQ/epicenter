<script lang="ts">
	import { numberFmt } from '$lib/format';
	import type { TableSummary } from '$lib/types';

	let {
		tables,
		selected,
		onSelect,
	}: {
		tables: TableSummary[];
		selected: string | null;
		onSelect: (table: string) => void;
	} = $props();
</script>

<nav class="w-56 shrink-0 overflow-y-auto border-r border-border bg-background">
	<div class="px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
		Tables
	</div>
	<ul class="pb-4">
		{#each tables as table (table.name)}
			<li>
				<button
					type="button"
					class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left font-mono text-sm hover:bg-muted/60
						{selected === table.name ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'}"
					onclick={() => onSelect(table.name)}
				>
					<span class="truncate">{table.name}</span>
					<span class="shrink-0 tabular-nums text-xs text-muted-foreground">
						{numberFmt.format(table.rowCount)}
					</span>
				</button>
			</li>
		{/each}
	</ul>
</nav>
