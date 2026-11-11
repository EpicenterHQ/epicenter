<!--
	Credits used over a chosen range: the total, a column per day, and each
	model's share. One query and one range drive all three, so they always
	describe the same days. Autumn returns every day in the range, zero days
	included, and folds no model away while fewer than nine are billed.
-->
<script lang="ts">
	import * as Card from '@epicenter/ui/card';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as Empty from '@epicenter/ui/empty';
	import { Progress } from '@epicenter/ui/progress';
	import * as Select from '@epicenter/ui/select';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import * as Table from '@epicenter/ui/table';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { createQuery } from '@tanstack/svelte-query';
	import { getDashboard } from '$lib/dashboard/context';

	const { billingQueries } = getDashboard();

	const ranges = [
		{ value: '7d', label: 'Last 7 days' },
		{ value: '30d', label: 'Last 30 days' },
		{ value: '90d', label: 'Last 90 days' },
	] as const;
	type Range = (typeof ranges)[number]['value'];

	let range = $state<Range>('30d');

	const usage = createQuery(() =>
		billingQueries.usage({ range, binSize: 'day', groupBy: 'model' }),
	);

	/** Bins start at midnight UTC, so the day is read in UTC too. */
	const dayLabel = (iso: string) =>
		new Date(iso).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC',
		});

	const days = $derived(
		(usage.data?.buckets ?? []).map((bucket) => ({
			iso: bucket.periodIso,
			credits: Object.values(bucket.groupedCredits).reduce(
				(sum, credits) => sum + credits,
				0,
			),
		})),
	);
	const peak = $derived(Math.max(0, ...days.map((day) => day.credits)));

	const models = $derived.by(() => {
		const totals = new Map<string, number>();
		for (const bucket of usage.data?.buckets ?? [])
			for (const [model, credits] of Object.entries(bucket.groupedCredits))
				totals.set(model, (totals.get(model) ?? 0) + credits);
		return [...totals]
			.filter(([, credits]) => credits > 0)
			.sort(([, a], [, b]) => b - a);
	});

	const totalCredits = $derived(usage.data?.totalCredits ?? 0);
	const totalCalls = $derived(usage.data?.totalCalls ?? 0);
	const share = (credits: number) =>
		totalCredits === 0 ? 0 : Math.round((credits / totalCredits) * 100);
</script>

<Card.Root class="mb-6">
	<Card.Header>
		<Card.Title class="text-sm font-medium">Credits used</Card.Title>
		<Card.Action>
		<Select.Root
			type="single"
			value={range}
			onValueChange={(next) => {
				if (next) range = next as Range;
			}}
		>
			<Select.Trigger size="sm" class="w-36 text-xs">
				{ranges.find((option) => option.value === range)?.label}
			</Select.Trigger>
			<Select.Content>
				<Select.Group>
					{#each ranges as option (option.value)}
						<Select.Item value={option.value}>{option.label}</Select.Item>
					{/each}
				</Select.Group>
			</Select.Content>
		</Select.Root>
		</Card.Action>
	</Card.Header>
	<Card.Content class="space-y-6">
		{#if usage.isPending}
			<Skeleton class="h-10 w-40" />
			<Skeleton class="h-32 w-full" />
		{:else if usage.isError}
			<Empty.Root class="border-0 py-12" role="alert">
				<Empty.Content>
					<Empty.Title class="text-destructive">Usage could not load</Empty.Title>
				</Empty.Content>
			</Empty.Root>
		{:else if totalCredits === 0}
			<Empty.Root class="border-0 py-8">
				<Empty.Content>
					<Empty.Title>No credits used in this range</Empty.Title>
					<Empty.Description>Credits your apps use will appear here by day and by model.</Empty.Description>
				</Empty.Content>
			</Empty.Root>
		{:else}
			<div>
				<p class="text-4xl font-semibold tabular-nums">
					{totalCredits.toLocaleString()}
				</p>
				<p class="text-sm text-muted-foreground">
					credits across {totalCalls.toLocaleString()} requests
				</p>
			</div>

			<figure class="space-y-1">
				<figcaption class="flex justify-between text-xs text-muted-foreground">
					<span>Credits per day</span>
					<span class="tabular-nums">peak {peak.toLocaleString()}</span>
				</figcaption>
				<div
					class="flex h-32 items-end gap-0.5 border-b border-border"
					role="img"
					aria-label="Credits per day, {dayLabel(days[0]?.iso ?? '')} to {dayLabel(days.at(-1)?.iso ?? '')}, peak {peak.toLocaleString()}"
				>
					{#each days as day (day.iso)}
						<Tooltip.Root>
							<Tooltip.Trigger>
								{#snippet child({ props })}
									<div
										{...props}
										tabindex="-1"
										class="group flex h-full max-w-6 min-w-0 flex-1 items-end"
									>
										<div
											class="w-full rounded-t-[4px] bg-primary/70 group-hover:bg-primary"
											style:height="{peak === 0 ? 0 : (day.credits / peak) * 100}%"
										></div>
									</div>
								{/snippet}
							</Tooltip.Trigger>
							<Tooltip.Content>
								<span class="font-medium tabular-nums">{day.credits.toLocaleString()}</span>
								credits, {dayLabel(day.iso)}
							</Tooltip.Content>
						</Tooltip.Root>
					{/each}
				</div>
				<div class="flex justify-between text-xs text-muted-foreground">
					<span>{dayLabel(days[0]?.iso ?? '')}</span>
					<span>{dayLabel(days.at(-1)?.iso ?? '')}</span>
				</div>
			</figure>

			<ul class="space-y-3" aria-label="Credits by model">
				{#each models as [model, credits] (model)}
					<li class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1">
						<span class="truncate font-mono text-xs">{model}</span>
						<span class="text-right text-sm tabular-nums">
							{credits.toLocaleString()}
							<span class="text-muted-foreground">· {share(credits)}%</span>
						</span>
						<Progress value={share(credits)} class="col-span-2" aria-label="{model}, {share(credits)}% of credits" />
					</li>
				{/each}
			</ul>

			<Collapsible.Root>
				<Collapsible.Trigger class="text-xs text-muted-foreground underline-offset-4 hover:underline">
					Daily totals
				</Collapsible.Trigger>
				<Collapsible.Content>
					<Table.Root class="mt-2">
						<Table.Header>
							<Table.Row>
								<Table.Head>Day</Table.Head>
								<Table.Head class="text-right">Credits</Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each days as day (day.iso)}
								<Table.Row>
									<Table.Cell>{dayLabel(day.iso)}</Table.Cell>
									<Table.Cell class="text-right tabular-nums">{day.credits.toLocaleString()}</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</Collapsible.Content>
			</Collapsible.Root>
		{/if}
	</Card.Content>
</Card.Root>
