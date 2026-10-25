<script lang="ts">
	import { getWhispering, type Whispering } from '../../../lib/whispering.svelte.js';
	import { getFolder, type WhisperingFolder } from '../../../lib/folder.js';

	let { report, route }: {
		report: (whispering: Whispering, folder: WhisperingFolder) => void;
		route: string;
	} = $props();
	// svelte-ignore state_referenced_locally
	report(getWhispering(), getFolder());
</script>

<p data-testid="route">{route}</p>
