<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import '@epicenter/ui/app.css';
	import { dictation } from '$lib/dictation.svelte';
	import { queryClient } from '$lib/queries';

	let { children } = $props();
</script>

<!-- An unsaved transcript edit is saved before the page goes away. -->
<svelte:window onpagehide={() => dictation.saveAll()} />

<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>
		{@render children()}
	</Tooltip.Provider>
</QueryClientProvider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
