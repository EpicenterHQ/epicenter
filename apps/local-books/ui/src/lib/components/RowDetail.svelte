<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import {
		createMutation,
		createQuery,
		useQueryClient,
	} from '@tanstack/svelte-query';
	import MousePointerClickIcon from '@lucide/svelte/icons/mouse-pointer-click';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { toast } from 'svelte-sonner';
	import { api } from '$lib/api';
	import { asJson, formatCell } from '$lib/format';

	let {
		table,
		id,
		readOnly,
	}: {
		table: string | null;
		id: string | null;
		readOnly: boolean;
	} = $props();

	const queryClient = useQueryClient();

	const detail = createQuery(() => ({
		queryKey: ['row', table, id],
		queryFn: () => api.row(table as string, id as string),
		enabled: table !== null && id !== null,
	}));

	// Every column value verbatim, split by rendering: scalars go in the grid,
	// serialized JSON (the raw blob, _meta values) gets a pretty-printed block.
	const entries = $derived(Object.entries(detail.data?.values ?? {}));
	const typeByName = $derived(
		new Map((detail.data?.columns ?? []).map((c) => [c.name, c.type])),
	);
	const scalarEntries = $derived(entries.filter(([, v]) => asJson(v) === null));
	const jsonEntries = $derived(
		entries.flatMap(([name, v]) => {
			const parsed = asJson(v);
			return parsed === null
				? []
				: [{ name, pretty: JSON.stringify(parsed, null, 2) }];
		}),
	);

	// Recategorize is the one QuickBooks write, and only expense transactions
	// carry an account-based line. The mirror table names the QB entity the API
	// verb takes. Hidden when read-only or for any other table.
	const RECATEGORIZE_TABLES: Record<string, 'Purchase' | 'Bill'> = {
		purchases: 'Purchase',
		bills: 'Bill',
	};
	const recategorizeEntity = $derived(
		table === null ? undefined : RECATEGORIZE_TABLES[table],
	);
	const canRecategorize = $derived(!readOnly && recategorizeEntity !== undefined);

	let targetAccountId = $state('');
	let targetAccountName = $state('');

	const recategorize = createMutation(() => ({
		mutationFn: () =>
			api.recategorize({
				entity: recategorizeEntity as 'Purchase' | 'Bill',
				id: id as string,
				account_id: targetAccountId.trim(),
				account_name: targetAccountName.trim() || undefined,
			}),
		onSuccess: (result) => {
			const moves = result.changed
				.map((c) => `${c.fromAccount ?? '(none)'} → ${c.toAccount}`)
				.join(', ');
			toast.success(`Recategorized ${result.entity} ${result.id}: ${moves}`);
			targetAccountId = '';
			targetAccountName = '';
			queryClient.invalidateQueries({ queryKey: ['row', table, id] });
			queryClient.invalidateQueries({ queryKey: ['rows'] });
			queryClient.invalidateQueries({ queryKey: ['tables'] });
		},
		onError: (error: Error) => toast.error(error.message),
	}));
</script>

<aside class="flex w-96 shrink-0 flex-col overflow-hidden border-l border-border bg-background">
	{#if !table || !id}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon">
				<MousePointerClickIcon class="size-5" />
			</Empty.Media>
			<Empty.Title>No row selected</Empty.Title>
			<Empty.Description>Select a row to inspect it.</Empty.Description>
		</Empty.Root>
	{:else if detail.isPending}
		<Loading class="flex-1" label="Loading row" />
	{:else if detail.error}
		<Empty.Root class="flex-1 border-0">
			<Empty.Media variant="icon">
				<TriangleAlertIcon class="size-5 text-destructive" />
			</Empty.Media>
			<Empty.Title>Could not load row</Empty.Title>
			<Empty.Description>{detail.error.message}</Empty.Description>
		</Empty.Root>
	{:else if detail.data}
		<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<header class="border-b border-border px-4 py-3">
				<div class="flex items-center gap-2">
					<span class="font-mono text-sm font-semibold">{detail.data.table}</span>
					<span class="font-mono text-xs text-muted-foreground">{id}</span>
					{#if detail.data.values.deleted === 1}
						<Badge variant="outline" class="text-amber-500">deleted</Badge>
					{/if}
				</div>
			</header>

			{#if scalarEntries.length > 0}
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-b border-border px-4 py-3 text-sm">
					{#each scalarEntries as [name, value] (name)}
						<dt class="font-mono text-xs text-muted-foreground">{name}</dt>
						<dd class="truncate text-right tabular-nums">
							{formatCell(value, { name, type: typeByName.get(name) ?? 'TEXT' })}
						</dd>
					{/each}
				</dl>
			{/if}

			{#if canRecategorize}
				<form
					class="border-b border-border px-4 py-3"
					onsubmit={(e) => {
						e.preventDefault();
						if (targetAccountId.trim()) recategorize.mutate();
					}}
				>
					<p class="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Recategorize
					</p>
					<div class="space-y-2">
						<Input
							bind:value={targetAccountId}
							placeholder="Target account id (accounts row id)"
							class="h-8 text-sm"
						/>
						<Input
							bind:value={targetAccountName}
							placeholder="Target account name (optional)"
							class="h-8 text-sm"
						/>
						<Button
							type="submit"
							size="sm"
							variant="outline"
							disabled={!targetAccountId.trim() || recategorize.isPending}
							class="w-full"
						>
							Move every expense line to this account
						</Button>
					</div>
					<p class="mt-2 text-xs text-muted-foreground">
						Writes through to QuickBooks, then folds the response into the mirror.
					</p>
				</form>
			{/if}

			{#each jsonEntries as entry (entry.name)}
				<div class="min-h-0 px-4 py-3">
					<p class="mb-1 font-mono text-xs font-medium text-muted-foreground">
						{entry.name}
					</p>
					<pre class="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-xs">{entry.pretty}</pre>
				</div>
			{/each}
		</div>
	{/if}
</aside>
