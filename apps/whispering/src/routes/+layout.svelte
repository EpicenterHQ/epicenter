<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import '@epicenter/ui/app.css';
	import { queryClient } from '#lib/queries.ts';
	import { settings } from '#lib/settings.svelte.ts';

	let { children } = $props();
</script>

<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>
		<!-- Settings are read once, before the first screen, so it never shows the wrong server. -->
		{#await settings.loaded then}
			{@render children()}
		{/await}
	</Tooltip.Provider>
</QueryClientProvider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
