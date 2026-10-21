<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { setFolder, type WhisperingContext } from '$lib/folder.js';
	import { setWhispering, type Whispering } from '$lib/whispering.svelte.js';
	import Home from '../../+page.svelte';
	import SelectionHost from './SelectionHost.svelte';

	let { whispering, context, home }: { whispering: Whispering; context: WhisperingContext; home: boolean } = $props();
	// svelte-ignore state_referenced_locally
	setWhispering(whispering);
	// svelte-ignore state_referenced_locally
	setFolder(context);
</script>

{#if home}
	<QueryClientProvider client={context.queryClient}>
		<Tooltip.Provider>
			<Home />
		</Tooltip.Provider>
	</QueryClientProvider>
{:else}
	<SelectionHost {context} {whispering} page={{ shown: true, tab: 'recordings' }} />
{/if}
