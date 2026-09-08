<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { toastOnError } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { billingKeys } from '$lib/billing/queries';
	import ActivityFeed from '$lib/components/ActivityFeed.svelte';
	import CreditBalance from '$lib/components/CreditBalance.svelte';
	import ModelCostGuide from '$lib/components/ModelCostGuide.svelte';
	import PlanComparison from '$lib/components/PlanComparison.svelte';
	import TopModels from '$lib/components/TopModels.svelte';
	import UsageChart from '$lib/components/UsageChart.svelte';
	import { getDashboard } from '$lib/dashboard/context';
	const { billing, billingApi, queryClient, signal } = getDashboard();
	// Sibling dashboard routes share the Account, but not this page's redirects.
	let pageDisposed = false;
	onDestroy(() => {
		pageDisposed = true;
	});

	const overview = createQuery(() => billing.overview.options);
	const plans = createQuery(() => billing.plans.options);
	const isOnTrial = $derived(overview.data?.trial != null);

	const topUpLabel = $derived(
		plans.data
			? `Buy ${plans.data.topUp.creditsPerPurchase.toLocaleString()} credits ($${plans.data.topUp.priceUsd})`
			: 'Buy credits',
	);

	async function openBillingPortal() {
		const { data, error } = await billingApi.portal();
		if (pageDisposed || signal.aborted) return;
		if (error) return toastOnError(error, 'Could not open billing portal');
		if (data.portalUrl) window.location.href = data.portalUrl;
	}

	const topUp = createMutation(() => billing.topUp.options);
</script>

<CreditBalance />

{#if isOnTrial}
	<Alert.Root class="mb-6">
		<Alert.Description class="flex items-center justify-between">
			<span>Add a payment method to keep Ultra after your trial ends.</span>
			<Button
				variant="ghost"
				size="sm"
				class="h-auto px-0 text-primary hover:bg-transparent hover:underline"
				onclick={openBillingPortal}
				>Update billing →</Button
			>
		</Alert.Description>
	</Alert.Root>
{/if}

<Tabs.Root value="overview">
	<Tabs.List>
		<Tabs.Trigger value="overview">Overview</Tabs.Trigger>
		<Tabs.Trigger value="models">Models</Tabs.Trigger>
		<Tabs.Trigger value="activity">Activity</Tabs.Trigger>
	</Tabs.List>

	<Tabs.Content value="overview" class="pt-6">
		<UsageChart />
		<TopModels />
	</Tabs.Content>

	<Tabs.Content value="models" class="pt-6"> <ModelCostGuide /> </Tabs.Content>

	<Tabs.Content value="activity" class="pt-6"> <ActivityFeed /> </Tabs.Content>
</Tabs.Root>

<PlanComparison />

<section class="flex flex-wrap gap-3">
	<Button
		variant="outline"
		onclick={() => {
			topUp.mutate(window.location.href, {
				onSuccess: (data) => {
					if (data.checkoutUrl) {
						window.location.href = data.checkoutUrl;
					} else {
						toast.success('Credits added to your account');
						queryClient.invalidateQueries({ queryKey: billingKeys.all });
					}
				},
				onError: (error) =>
					toast.error('Top-up failed', {
						description: extractErrorMessage(error),
					}),
			});
		}}
		disabled={topUp.isPending}
	>
		{#if topUp.isPending}
			<Spinner class="size-3.5" />
		{:else}
			{topUpLabel}
		{/if}
	</Button>
	<Button variant="outline" onclick={openBillingPortal}>Manage billing</Button>
</section>
