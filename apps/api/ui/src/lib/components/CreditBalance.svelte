<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import * as Card from '@epicenter/ui/card';
	import { Progress } from '@epicenter/ui/progress';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { createQuery } from '@tanstack/svelte-query';
	import { getDashboard } from '$lib/dashboard/context';
	const { billing } = getDashboard();

	const overview = createQuery(() => billing.overview.options);

	const credits = $derived(overview.data?.credits ?? null);
	const trial = $derived(overview.data?.trial ?? null);
	const planDisplayName = $derived(overview.data?.planDisplayName ?? 'Free');

	const usagePercent = $derived(
		credits && credits.granted > 0
			? Math.min(100, Math.round((credits.remaining / credits.granted) * 100))
			: 0,
	);

	const daysUntilReset = $derived(
		credits?.nextResetAtMs != null
			? Math.max(
					0,
					Math.ceil((credits.nextResetAtMs - Date.now()) / 86_400_000),
				)
			: null,
	);

	const trialIsUrgent = $derived(trial !== null && trial.daysLeft <= 3);
</script>

{#if overview.isPending}
	<Card.Root class="mb-8">
		<Card.Header> <Skeleton class="h-6 w-20" /> </Card.Header>
		<Card.Content>
			<Skeleton class="h-8 w-32 mb-3" />
			<Skeleton class="h-2 w-full" />
		</Card.Content>
	</Card.Root>
{:else if overview.isError}
	<Card.Root class="mb-8 border-destructive">
		<Card.Content class="pt-6">
			<p class="text-sm text-destructive">
				Failed to load balance. Try refreshing.
			</p>
		</Card.Content>
	</Card.Root>
{:else if credits}
	<Card.Root class="mb-8">
		<Card.Header class="flex-row items-center justify-between space-y-0 pb-2">
			<Card.Title class="text-sm font-medium">Credits</Card.Title>
			{#if daysUntilReset !== null}
				<Badge variant="secondary" class="text-xs">
					Resets in {daysUntilReset} day{daysUntilReset === 1 ? '' : 's'}
				</Badge>
			{/if}
			{#if trial}
				<Badge
					variant={trialIsUrgent ? 'destructive' : 'outline'}
					class={trialIsUrgent
						? ''
						: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'}
				>
					{planDisplayName}
					Trial: {trial.daysLeft} day{trial.daysLeft === 1 ? '' : 's'}
					left
				</Badge>
			{/if}
		</Card.Header>
		<Card.Content>
			<div class="flex items-baseline gap-2 mb-3">
				<span class="text-3xl font-bold tabular-nums">
					{credits.remaining.toLocaleString()}
				</span>
				<span class="text-sm text-muted-foreground">
					of {credits.granted.toLocaleString()} included
				</span>
			</div>

			<Progress value={usagePercent} class="h-2 mb-3" />

			{#if credits.rolloverRemaining > 0}
				<div class="flex gap-4 text-xs text-muted-foreground">
					<span>Monthly: {credits.monthlyRemaining.toLocaleString()}</span>
					<span>Rollover: {credits.rolloverRemaining.toLocaleString()}</span>
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
{/if}
