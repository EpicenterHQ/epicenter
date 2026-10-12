<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
	import { ModeWatcher } from 'mode-watcher';
	import '../app.css';

	let { children } = $props();

	// One cache for the app: the words and chats it shows, and every write and action.
	const queryClient = new QueryClient();
</script>

<svelte:head><title>Vocab</title></svelte:head>

<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
</QueryClientProvider>

<Toaster />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
