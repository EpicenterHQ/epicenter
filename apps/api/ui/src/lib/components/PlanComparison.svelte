<script lang="ts">
	import type { BillingPlanCard } from '$api/billing/contracts';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Card from '@epicenter/ui/card';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { billingKeys } from '$lib/billing/queries';
	import { getDashboard } from '$lib/dashboard/context';
	const { billing, queryClient } = getDashboard();

	let isAnnual = $state(false);
	let confirmDialog = $state.raw<{ card: BillingPlanCard } | null>(null);

	const overview = createQuery(() => billing.overview.options);
	const plans = createQuery(() => billing.plans.options);

	const visibleCards = $derived<BillingPlanCard[]>(
		isAnnual
			? (plans.data?.cards.annual ?? [])
			: (plans.data?.cards.monthly ?? []),
	);

	const currentPlanDisplayName = $derived(
		overview.data?.planDisplayName ?? null,
	);
	const trial = $derived(overview.data?.trial ?? null);
	const trialEndDate = $derived(
		trial
			? new Date(trial.endsAtMs).toLocaleDateString('en-US', {
					month: 'short',
					day: 'numeric',
				})
			: null,
	);

	const previewMutation = createMutation(
		() => billing.previewPlanChange.options,
	);
	const checkoutMutation = createMutation(() => billing.checkoutPlan.options);

	const previewSummary = $derived(
		previewMutation.data?.displayedSummary ?? null,
	);

	function handleUpgradeClick(card: BillingPlanCard) {
		confirmDialog = { card };
		previewMutation.reset();
		previewMutation.mutate({ planId: card.id });
	}
</script>

<section class="mt-10 mb-8">
	<div class="flex items-center justify-between mb-4">
		<h2 class="text-lg font-semibold">Plans</h2>
		<div class="flex items-center gap-2 rounded-lg bg-muted p-1 text-xs">
			<Button
				variant="ghost"
				size="sm"
				class="rounded-md {!isAnnual ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
				onclick={() => (isAnnual = false)}
				>Monthly</Button
			>
			<Button
				variant="ghost"
				size="sm"
				class="rounded-md {isAnnual ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
				onclick={() => (isAnnual = true)}
				>Annual <span class="ml-1 text-emerald-500">Save ~17%</span></Button
			>
		</div>
	</div>

	{#if plans.isPending}
		<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
			{#each Array(3) as _}
				<Skeleton class="h-64" />
			{/each}
		</div>
	{:else}
		<div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
			{#each visibleCards as card (card.id)}
				<Card.Root
					class="{card.isRecommended ? 'border-primary ring-1 ring-primary' : ''} {card.cta === 'Current' ? 'border-emerald-700 bg-emerald-950/20' : ''} flex flex-col"
				>
					<Card.Header class="pb-2">
						<div class="flex items-center gap-2">
							<Card.Title>{card.displayName}</Card.Title>
							{#if card.isRecommended}
								<Badge variant="default" class="text-xs">Recommended</Badge>
							{/if}
						</div>
						<p class="text-2xl font-bold">
							{isAnnual ? card.displayedPricePerMonth : card.displayedPrice}
						</p>
					</Card.Header>
					<Card.Content class="flex-1 space-y-2 text-sm text-muted-foreground">
						<p>{card.displayedCreditsPerCycle}</p>
						{#if card.displayedOverage}
							<p>{card.displayedOverage}</p>
						{/if}
						<p>All AI models</p>
						{#if card.rollover}
							<p class="text-emerald-400">∞ credit rollover</p>
						{:else}
							<p>Credits reset monthly</p>
						{/if}
					</Card.Content>
					<Card.Footer>
						{#if card.cta === 'Current' || card.cta === 'Scheduled'}
							<Button variant="outline" class="w-full" disabled>
								{card.cta === 'Current' ? 'Current plan' : 'Scheduled'}
								{#if card.isTrialing}
									&nbsp;(trial)
								{/if}
							</Button>
						{:else}
							<Button
								class="w-full"
								variant={card.cta === 'Upgrade' ? 'default' : 'secondary'}
								onclick={() => handleUpgradeClick(card)}
							>
								{card.cta}
								to {card.displayName}
							</Button>
						{/if}
					</Card.Footer>
				</Card.Root>
			{/each}
		</div>

		<p class="mt-4 text-xs text-muted-foreground text-center">
			{#if trialEndDate && currentPlanDisplayName}
				Currently on {currentPlanDisplayName} trial: ends {trialEndDate}.
			{:else if currentPlanDisplayName}
				Currently on {currentPlanDisplayName}.
			{/if}
			All plans include cloud sync, unlimited workspaces, and unlimited
			history.
		</p>
	{/if}
</section>

<!-- Upgrade confirmation dialog -->
<Dialog.Root
	open={!!confirmDialog}
	onOpenChange={(open) => {
		if (!open) confirmDialog = null;
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>
				{confirmDialog
					? `${confirmDialog.card.cta} to ${confirmDialog.card.displayName}`
					: ''}
			</Dialog.Title>
			<Dialog.Description>
				{#if previewMutation.isPending}
					Calculating cost...
				{:else if previewSummary}
					{previewSummary}
				{:else}
					Confirm your plan change.
				{/if}
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (confirmDialog = null)}>
				Cancel
			</Button>
			<Button
				onclick={() => {
					if (!confirmDialog) return;
					checkoutMutation.mutate(
						{
							planId: confirmDialog.card.id,
							successUrl: window.location.href,
						},
						{
							onSuccess: (data) => {
								if (data.checkoutUrl) {
									window.location.href = data.checkoutUrl;
								} else {
									toast.success('Plan updated successfully');
									confirmDialog = null;
									queryClient.invalidateQueries({ queryKey: billingKeys.all });
								}
							},
							onError: (error) =>
								toast.error('Upgrade failed', {
									description: extractErrorMessage(error),
								}),
						},
					);
				}}
				disabled={checkoutMutation.isPending}
			>
				{#if checkoutMutation.isPending}
					<Spinner class="size-3.5" />
				{:else}
					Confirm
				{/if}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
