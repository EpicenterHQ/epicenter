<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { ModeWatcher } from 'mode-watcher';
	import '@epicenter/ui/app.css';
	import { queryClient } from '$lib/query.js';

	let props = $props();
</script>

<svelte:head><title>Todos</title></svelte:head>

<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>{@render props.children?.()}</Tooltip.Provider>
</QueryClientProvider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
