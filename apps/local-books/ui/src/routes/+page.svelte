<script lang="ts">
	import {
		createMutation,
		createQuery,
		useQueryClient,
	} from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { api } from '$lib/api';
	import QueryPanel from '$lib/components/QueryPanel.svelte';
	import ReportPanel from '$lib/components/ReportPanel.svelte';
	import RowDetail from '$lib/components/RowDetail.svelte';
	import RowTable from '$lib/components/RowTable.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import TableRail from '$lib/components/TableRail.svelte';

	type Tab = 'browse' | 'query' | 'reports';
	const TABS: { id: Tab; label: string }[] = [
		{ id: 'browse', label: 'Browse' },
		{ id: 'query', label: 'Query' },
		{ id: 'reports', label: 'Reports' },
	];
	let tab = $state<Tab>('browse');

	let selectedTable = $state<string | null>(null);
	let selectedRowId = $state<string | null>(null);

	const queryClient = useQueryClient();

	const status = createQuery(() => ({
		queryKey: ['status'],
		queryFn: () => api.status(),
	}));
	const tables = createQuery(() => ({
		queryKey: ['tables'],
		queryFn: () => api.tables(),
	}));
	const rows = createQuery(() => ({
		queryKey: ['rows', selectedTable],
		queryFn: () => api.rows(selectedTable as string, { limit: 200 }),
		enabled: selectedTable !== null,
	}));

	const sync = createMutation(() => ({
		mutationFn: () => api.sync(),
		onSuccess: (outcome) => {
			if (outcome.failures.length > 0) {
				toast.error(`Sync finished with ${outcome.failures.length} failure(s).`);
			} else {
				const upserted = outcome.entities.reduce((n, e) => n + e.upserted, 0);
				const deleted = outcome.entities.reduce((n, e) => n + e.deleted, 0);
				toast.success(
					`${outcome.mode} sync: ${upserted} upserted, ${deleted} removed.`,
				);
			}
			queryClient.invalidateQueries({ queryKey: ['status'] });
			queryClient.invalidateQueries({ queryKey: ['tables'] });
			queryClient.invalidateQueries({ queryKey: ['rows'] });
			queryClient.invalidateQueries({ queryKey: ['row'] });
		},
		onError: (error: Error) => toast.error(error.message),
	}));

	const tableList = $derived(tables.data?.tables ?? []);
	const syncError = $derived(sync.error?.message ?? null);

	// Default the selection to the first data table with rows worth browsing,
	// falling back to the first data table so the pane is never empty. `_meta` is
	// sync bookkeeping, so it never wins by default (it stays reachable by click).
	$effect(() => {
		if (selectedTable !== null || tableList.length === 0) return;
		const data = tableList.filter((t) => t.name !== '_meta');
		const withRows = data.find((t) => t.rowCount > 0);
		selectedTable =
			withRows?.name ?? data[0]?.name ?? tableList[0]?.name ?? null;
	});

	// Keep the row selection valid: default to the first addressable row, and
	// re-resolve when a table change drops the current selection out of the list.
	$effect(() => {
		const page = rows.data;
		const list = page?.rows ?? [];
		const pk = page?.pk ?? null;
		if (list.length === 0 || pk === null) {
			selectedRowId = null;
			return;
		}
		const keys = list
			.map((r) => r[pk])
			.filter((v) => v !== null && v !== undefined)
			.map(String);
		if (!selectedRowId || !keys.includes(selectedRowId)) {
			selectedRowId = keys[0] ?? null;
		}
	});

	function selectTable(table: string) {
		selectedTable = table;
		selectedRowId = null;
	}
</script>

<div class="flex h-full flex-col">
	<StatusBar
		status={status.data}
		syncing={sync.isPending}
		{syncError}
		onRefresh={() => sync.mutate()}
	/>

	<div class="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-background px-3">
		{#each TABS as t (t.id)}
			<button
				type="button"
				class="rounded px-3 py-1 text-sm {tab === t.id
					? 'bg-muted font-medium text-foreground'
					: 'text-muted-foreground hover:text-foreground'}"
				onclick={() => (tab = t.id)}
			>
				{t.label}
			</button>
		{/each}
	</div>

	<div class="flex min-h-0 flex-1">
		{#if tab === 'browse'}
			<TableRail
				tables={tableList}
				selected={selectedTable}
				onSelect={selectTable}
			/>
			<RowTable
				page={rows.data}
				loading={rows.isPending && selectedTable !== null}
				error={rows.error?.message ?? null}
				selectedId={selectedRowId}
				onSelect={(id) => (selectedRowId = id)}
			/>
			<RowDetail
				table={selectedTable}
				id={selectedRowId}
				readOnly={status.data?.readOnly ?? false}
			/>
		{:else if tab === 'query'}
			<QueryPanel />
		{:else}
			<ReportPanel />
		{/if}
	</div>
</div>
