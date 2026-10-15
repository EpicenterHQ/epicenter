<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
	import { ModeWatcher } from 'mode-watcher';
	import '@epicenter/ui/app.css';

	let props = $props();

	// One cache for the app: the files it shows, and every write and action.
	// The folder's queries are read again only when its change channel or
	// the page's own write says so.
	const queryClient = new QueryClient();
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>{@render props.children?.()}</Tooltip.Provider>
</QueryClientProvider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
