<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import '@epicenter/ui/app.css';
	import { queryClient } from '#lib/queries.ts';

	let { children } = $props();
</script>

<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>
		{@render children()}
	</Tooltip.Provider>
</QueryClientProvider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
