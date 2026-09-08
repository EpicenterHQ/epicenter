<script lang="ts">
	import { attachDesktopClose } from '@epicenter/app-shell/boot-screens';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount, tick } from 'svelte';
	import { mail } from '$lib/mail';
	import '../app.css';

	let { children } = $props();
	let closing = $state(false);

	onMount(() => {
		const attached = attachDesktopClose(async () => {
			closing = true;
			const drained = mail.close();
			await tick();
			await queryClient.cancelQueries();
			await drained;
			queryClient.clear();
		});
		void attached.catch((error) =>
			console.error('Could not listen for application close.', error),
		);
		return () => {
			void attached.then((detach) => detach(), () => {});
		};
	});

	// The mirror is a local SQLite read, so refetch is cheap and staleness
	// matters: a reconcile pass changes rows underneath an open page. Keep
	// staleTime short and refetch on focus.
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { staleTime: 5_000, retry: 1 },
		},
	});
</script>

<svelte:head><title>Local Mail</title></svelte:head>

<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>
		<div class="h-dvh bg-background text-foreground">
			{#if !closing}
				{@render children()}
			{:else}
				<p class="p-6">Closing Local Mail…</p>
			{/if}
		</div>
	</Tooltip.Provider>
</QueryClientProvider>

<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
