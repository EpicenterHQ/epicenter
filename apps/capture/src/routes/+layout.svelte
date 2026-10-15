<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
	import '@epicenter/ui/app.css';
	let { children } = $props();

	// One cache for the app: the files it shows, and every write and action.
	// The folder's queries are read again only when its change channel (the
	// page wires it) or the page's own write says so.
	const queryClient = new QueryClient();
</script>

<svelte:head><title>Capture</title></svelte:head>
<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
</QueryClientProvider>
<Toaster closeButton />
<ConfirmationDialog />
