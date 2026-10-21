<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { setFolder } from '$lib/folder.js';
	import { setWhispering, type Whispering } from '$lib/whispering.svelte.js';
	import Home from '../../+page.svelte';
	import SelectionHost from './SelectionHost.svelte';

	let { whispering, home }: { whispering: Whispering; home: boolean } = $props();
	// svelte-ignore state_referenced_locally
	setWhispering(whispering);
	// svelte-ignore state_referenced_locally
	setFolder(whispering.library.local);
</script>

{#if home}
	<QueryClientProvider client={whispering.library.local.queryClient}>
		<Tooltip.Provider>
			<Home />
		</Tooltip.Provider>
	</QueryClientProvider>
{:else}
	<SelectionHost library={whispering.library} page={{ shown: true, tab: 'recordings' }} />
{/if}
