<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
	import { onDestroy, untrack, type Snippet } from 'svelte';
	import { dev } from '$app/environment';
	import { page } from '$app/state';
	import { Button } from '@epicenter/ui/button';
	import UserMenu from '$lib/components/UserMenu.svelte';
	import { billingKeys } from '$lib/billing/queries';
	import { setDashboard } from './context.js';
	import { createDashboardRuntime } from './runtime.js';

	const expectedPrincipal = $derived(page.url.searchParams.get('expectedPrincipal'));

	let { account, children }: { account: Account; children: Snippet } = $props();
	// The parent keys this component on Account identity.
	const dashboard = createDashboardRuntime(untrack(() => account));
	setDashboard(dashboard);
	onDestroy(() => dashboard[Symbol.dispose]());
</script>

<svelte:window onfocus={() => dashboard.queryClient.refetchQueries({ queryKey: billingKeys.overview, exact: true, type: 'active' })} />

<QueryClientProvider client={dashboard.queryClient}>
	<header class="border-b bg-background/95 backdrop-blur">
		<div class="mx-auto max-w-5xl px-6 py-3 flex flex-wrap items-center justify-between gap-3">
			<span class="text-sm font-semibold tracking-tight">Epicenter</span>
			<UserMenu />
		</div>
		<nav aria-label="Account sections" class="mx-auto max-w-5xl px-6 pb-3 flex gap-2">
			{#each [{ href: '/dashboard', label: 'Credits' }, { href: '/dashboard/usage', label: 'Usage' }, { href: '/dashboard/account', label: 'Account' }] as section}
				<Button href={section.href + (expectedPrincipal ? '?' + new URLSearchParams({ expectedPrincipal }).toString() : '')} variant={page.url.pathname === section.href ? 'secondary' : 'ghost'} size="sm" aria-current={page.url.pathname === section.href ? 'page' : undefined}>{section.label}</Button>
			{/each}
		</nav>
	</header>
	<main class="mx-auto max-w-5xl px-6 py-8">{@render children()}</main>
	{#if dev}
		<SvelteQueryDevtools client={dashboard.queryClient} buttonPosition="bottom-right" />
	{/if}
</QueryClientProvider>
