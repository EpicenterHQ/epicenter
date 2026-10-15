<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
	import '@epicenter/ui/app.css';
	let { children } = $props();

	// One cache for the app: the files it shows, and every write and action.
	// The folder's change channel says when files changed (the page wires it),
	// so returning to the window reads nothing again.
	const queryClient = new QueryClient({
		defaultOptions: { queries: { refetchOnWindowFocus: false } },
	});
</script>

<svelte:head><title>Capture</title></svelte:head>
<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
</QueryClientProvider>
<Toaster closeButton />
<ConfirmationDialog />
