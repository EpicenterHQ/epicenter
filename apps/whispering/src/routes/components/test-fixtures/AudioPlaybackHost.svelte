<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { setFolder, type WhisperingFolder } from '$lib/folder.js';
	import { setWhispering, type Whispering } from '$lib/whispering.svelte.js';
	import Home from '../../+page.svelte';
	import SelectionHost from './SelectionHost.svelte';

	let { whispering, folder, home }: { whispering: Whispering; folder: WhisperingFolder; home: boolean } = $props();
	// svelte-ignore state_referenced_locally
	setWhispering(whispering);
	// svelte-ignore state_referenced_locally
	setFolder(folder);
</script>

{#if home}
	<Tooltip.Provider>
		<Home />
	</Tooltip.Provider>
{:else}
	<SelectionHost {folder} {whispering} page={{ shown: true, tab: 'recordings' }} />
{/if}
