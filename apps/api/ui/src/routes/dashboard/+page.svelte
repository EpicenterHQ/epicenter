<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { toastOnError } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { billingKeys } from '$lib/billing/queries';
	import CreditBalance from '$lib/components/CreditBalance.svelte';
	import PlanComparison from '$lib/components/PlanComparison.svelte';
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

	let openingPortal = $state(false);
	async function openBillingPortal() {
		if (openingPortal || pageDisposed || signal.aborted) return;
		openingPortal = true;
		try {
			const { data, error } = await billingApi.portal(window.location.href);
			if (pageDisposed || signal.aborted) return;
			if (error) return toastOnError(error, 'Could not open billing portal');
			if (data.portalUrl) window.location.href = data.portalUrl;
		} finally {
			openingPortal = false;
		}
	}

	const topUp = createMutation(() => billing.topUp.options);
</script>

<svelte:head><title>Credits: Epicenter</title></svelte:head>

<div class="mb-6 space-y-1">
	<h1 class="text-2xl font-semibold">Credits</h1>
	<p class="text-sm text-muted-foreground">Your Epicenter credits are shared across apps.</p>
</div>

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

<section aria-label="Credit purchases" class="flex flex-wrap gap-3">
	<Button
		onclick={() => {
			topUp.mutate(window.location.href, {
				onSuccess: (data) => {
					if (pageDisposed || signal.aborted) return;
					if (data.checkoutUrl) {
						window.location.href = data.checkoutUrl;
					} else {
						toast.success('Credits added to your account');
						queryClient.invalidateQueries({ queryKey: billingKeys.all });
					}
				},
				onError: (error) => {
					if (pageDisposed || signal.aborted) return;
					toast.error('Top-up failed', { description: extractErrorMessage(error) });
				},
			});
		}}
		disabled={topUp.isPending || !plans.data}
	>
		{#if topUp.isPending}
			<Spinner class="size-3.5" /> Opening purchase…
		{:else}
			{topUpLabel}
		{/if}
	</Button>
	<Button variant="outline" onclick={openBillingPortal} disabled={openingPortal}>
		{#if openingPortal}<Spinner class="size-3.5" /> Opening billing…{:else}Manage billing{/if}
	</Button>
</section>

<PlanComparison />
