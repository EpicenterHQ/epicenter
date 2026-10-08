<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Table from '@epicenter/ui/table';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createMutation } from '@tanstack/svelte-query';
	import { api } from '$lib/api';
	import { numberFmt } from '$lib/format';

	// A read-only SQL surface over the mirror. The connection rejects writes and the
	// result is row-capped server-side, so this is safe to hand any query.
	let sql = $state(
		'SELECT display_name, balance FROM customers WHERE balance > 0 ORDER BY balance DESC',
	);

	const run = createMutation(() => ({
		mutationFn: (query: string) => api.query(query),
	}));

	const rows = $derived(run.data?.rows ?? []);
	const columns = $derived(rows.length > 0 ? Object.keys(rows[0] as object) : []);

	function submit() {
		if (sql.trim()) run.mutate(sql);
	}

	function cell(value: unknown): string {
		if (value === null || value === undefined) return '';
		if (typeof value === 'object') return JSON.stringify(value);
		return String(value);
	}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div class="shrink-0 border-b border-border p-3">
		<Textarea
			bind:value={sql}
			spellcheck={false}
			rows={4}
			class="font-mono text-xs md:text-xs"
			placeholder="SELECT … FROM invoices WHERE deleted = 0"
			onkeydown={(e) => {
				// Cmd/Ctrl+Enter runs, the muscle-memory of every SQL console.
				if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
					e.preventDefault();
					submit();
				}
			}}
		/>
		<div class="mt-2 flex items-center gap-3">
			<Button size="sm" onclick={submit} disabled={run.isPending || !sql.trim()}>
				{#if run.isPending}<Spinner class="size-3.5" />{/if}
				Run
			</Button>
			<span class="text-xs text-muted-foreground">
				Read-only. Writes are rejected at the connection. ⌘/Ctrl+Enter runs.
			</span>
			{#if run.data}
				<span class="ml-auto text-xs text-muted-foreground tabular-nums">
					{numberFmt.format(run.data.rowCount)} rows{run.data.truncated
						? ' (capped)'
						: ''}
				</span>
			{/if}
		</div>
	</div>

	<div class="min-h-0 flex-1 overflow-auto">
		{#if run.error}
			<p class="p-4 text-sm text-destructive">{run.error.message}</p>
		{:else if rows.length === 0}
			<p class="p-4 text-sm text-muted-foreground">
				{run.data ? 'No rows matched.' : 'Run a query to see results.'}
			</p>
		{:else}
			<Table.Root class="text-sm">
				<Table.Header>
					<Table.Row>
						{#each columns as column (column)}
							<Table.Head class="font-mono text-xs">{column}</Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each rows as row, i (i)}
						<Table.Row>
							{#each columns as column (column)}
								<Table.Cell class="max-w-xs truncate">
									{cell((row as Record<string, unknown>)[column])}
								</Table.Cell>
							{/each}
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</div>
</div>
