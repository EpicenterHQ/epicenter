<script lang="ts">
	import * as Card from '@epicenter/ui/card';
	import * as Empty from '@epicenter/ui/empty';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import * as Table from '@epicenter/ui/table';
	import { createQuery } from '@tanstack/svelte-query';
	import { getDashboard } from '$lib/dashboard/context';
	const { billing } = getDashboard();

	const usage = createQuery(
		() =>
			billing.usage({
				range: '30d',
				binSize: 'day',
				groupBy: 'model',
			}).options,
	);

	/** Aggregate per-model totals across all time periods. */
	const modelTotals = $derived(
		(usage.data?.buckets ?? []).reduce(
			(acc: Record<string, number>, bucket) => {
				for (const [model, count] of Object.entries(bucket.groupedCredits)) {
					acc[model] = (acc[model] ?? 0) + count;
				}
				return acc;
			},
			{} as Record<string, number>,
		),
	);

	const sortedModels = $derived(
		Object.entries(modelTotals)
			.sort(([, a], [, b]) => b - a)
			.slice(0, 10),
	);
</script>

<Card.Root class="mb-6">
	<Card.Header>
		<Card.Title class="text-sm font-medium">Top Models (30d)</Card.Title>
	</Card.Header>
	<Card.Content>
		{#if usage.isPending}
			<div class="space-y-2">
				{#each Array(5) as _}
					<Skeleton class="h-8 w-full" />
				{/each}
			</div>
		{:else if usage.isError}
			<Empty.Root class="py-4 border-0" role="alert">
				<Empty.Content>
					<Empty.Title class="text-destructive"
						>Failed to load model data</Empty.Title
					>
				</Empty.Content>
			</Empty.Root>
		{:else if sortedModels.length === 0}
			<Empty.Root class="py-4 border-0">
				<Empty.Content>
					<Empty.Title>No usage data yet</Empty.Title>
					<Empty.Description
						>Your most-used models will appear here.</Empty.Description
					>
				</Empty.Content>
			</Empty.Root>
		{:else}
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head>Model</Table.Head>
						<Table.Head class="text-right">Credits</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each sortedModels as [ model, credits ] (model)}
						<Table.Row>
							<Table.Cell class="font-mono text-xs">{model}</Table.Cell>
							<Table.Cell class="text-right tabular-nums">
								{credits.toLocaleString()}
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</Card.Content>
</Card.Root>
