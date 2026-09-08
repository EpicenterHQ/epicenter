<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { SvelteQueryDevtools } from '@tanstack/svelte-query-devtools';
	import { onDestroy, untrack, type Snippet } from 'svelte';
	import { dev } from '$app/environment';
	import UserMenu from '$lib/components/UserMenu.svelte';
	import { setDashboard } from './context.js';
	import { createDashboardRuntime } from './runtime.js';

	let { account, children }: { account: Account; children: Snippet } = $props();
	// The parent keys this component on Account identity.
	const dashboard = createDashboardRuntime(untrack(() => account));
	setDashboard(dashboard);
	onDestroy(() => dashboard[Symbol.dispose]());
</script>

<QueryClientProvider client={dashboard.queryClient}>
	<header class="border-b bg-background/95 backdrop-blur">
		<div class="mx-auto max-w-5xl px-6 flex items-center justify-between h-14">
			<span class="text-sm font-semibold tracking-tight">Epicenter</span>
			<UserMenu />
		</div>
	</header>
	<div class="mx-auto max-w-5xl px-6 py-12">{@render children()}</div>
	{#if dev}
		<SvelteQueryDevtools client={dashboard.queryClient} buttonPosition="bottom-right" />
	{/if}
</QueryClientProvider>
