<script lang="ts">
	import * as Card from '@epicenter/ui/card';
	import * as Chart from '@epicenter/ui/chart';
	import * as Empty from '@epicenter/ui/empty';
	import * as Select from '@epicenter/ui/select';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { createQuery } from '@tanstack/svelte-query';
	import { scaleUtc } from 'd3-scale';
	import { curveMonotoneX } from 'd3-shape';
	import { AreaChart } from 'layerchart';
	import { getDashboard } from '$lib/dashboard/context';
	const { billing } = getDashboard();

	type Range = '7d' | '30d' | '90d';

	/** Chart color palette: up to 8 series (matches shadcn chart vars). */
	const CHART_COLORS = [
		'var(--chart-1)',
		'var(--chart-2)',
		'var(--chart-3)',
		'var(--chart-4)',
		'var(--chart-5)',
		'hsl(280 65% 60%)',
		'hsl(340 75% 55%)',
		'hsl(160 60% 45%)',
	];

	let selectedRange = $state<Range>('30d');

	const usage = createQuery(
		() =>
			billing.usage({
				range: selectedRange,
				binSize: selectedRange === '7d' ? 'hour' : 'day',
				groupBy: 'model',
				maxGroups: 8,
			}).options,
	);

	const rangeOptions = [
		{ value: '7d' as const, label: '7 days' },
		{ value: '30d' as const, label: '30 days' },
		{ value: '90d' as const, label: '90 days' },
	];

	const totalCredits = $derived(usage.data?.totalCredits ?? 0);
	const totalCalls = $derived(usage.data?.totalCalls ?? 0);

	/** Discover all model names across the response, sorted by total
	 *  usage descending. These become the chart series keys. */
	const modelNames = $derived.by(() => {
		const totals: Record<string, number> = {};
		for (const bucket of usage.data?.buckets ?? []) {
			for (const [model, count] of Object.entries(bucket.groupedCredits)) {
				totals[model] = (totals[model] ?? 0) + count;
			}
		}
		return Object.entries(totals)
			.sort(([, a], [, b]) => b - a)
			.map(([name]) => name);
	});

	/** Flat rows for LayerChart. One row per bucket. */
	const chartData = $derived(
		(usage.data?.buckets ?? []).map((bucket) => {
			const row: Record<string, unknown> = {
				date: new Date(bucket.periodIso),
			};
			for (const model of modelNames) {
				row[model] = bucket.groupedCredits[model] ?? 0;
			}
			return row;
		}),
	);

	const chartConfig = $derived(
		Object.fromEntries(
			modelNames.map((name, i) => [
				name,
				{ label: name, color: CHART_COLORS[i % CHART_COLORS.length] },
			]),
		) satisfies Chart.ChartConfig,
	);

	const series = $derived(
		modelNames.map((name, i) => ({
			key: name,
			label: name,
			color: CHART_COLORS[i % CHART_COLORS.length],
		})),
	);
</script>

<Card.Root class="mb-6">
	<Card.Header class="flex-row items-center justify-between space-y-0 pb-2">
		<Card.Title class="text-sm font-medium">Usage</Card.Title>
		<Select.Root
			type="single"
			value={selectedRange}
			onValueChange={(v) => {
				if (v) selectedRange = v as Range;
			}}
		>
			<Select.Trigger class="w-[120px] h-8 text-xs">
				{rangeOptions.find((o) => o.value === selectedRange)?.label}
			</Select.Trigger>
			<Select.Content>
				{#each rangeOptions as opt (opt.value)}
					<Select.Item value={opt.value}>{opt.label}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
	</Card.Header>
	<Card.Content>
		{#if usage.isPending}
			<Skeleton class="h-48 w-full" />
		{:else if usage.isError}
			<Empty.Root class="py-12 border-0" role="alert">
				<Empty.Content>
					<Empty.Title class="text-destructive"
						>Failed to load usage data</Empty.Title
					>
				</Empty.Content>
			</Empty.Root>
		{:else if chartData.length === 0}
			<Empty.Root class="py-8 border-0">
				<Empty.Content>
					<Empty.Title>No usage data yet</Empty.Title>
					<Empty.Description
						>Credits you use will appear here as a chart.</Empty.Description
					>
				</Empty.Content>
			</Empty.Root>
		{:else}
			<Chart.Container config={chartConfig} class="aspect-[3/1] w-full">
				<AreaChart
					data={chartData}
					x="date"
					xScale={scaleUtc()}
					yPadding={[0, 15]}
					{series}
					seriesLayout="stack"
					props={{
						area: {
							curve: curveMonotoneX,
							'fill-opacity': 0.4,
							line: { class: 'stroke-1' },
						},
						xAxis: {
							format: (v: Date) =>
								v.toLocaleDateString('en-US', {
									month: 'short',
									day: 'numeric',
								}),
						},
						yAxis: {
							format: (v: number) =>
								v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v),
						},
					}}
				/>
			</Chart.Container>

			<div
				class="mt-4 flex items-center justify-between text-xs text-muted-foreground"
			>
				<span>Total: {totalCredits.toLocaleString()} credits</span>
				{#if totalCalls > 0}
					<span>{totalCalls.toLocaleString()} requests</span>
				{/if}
			</div>
		{/if}
	</Card.Content>
</Card.Root>
