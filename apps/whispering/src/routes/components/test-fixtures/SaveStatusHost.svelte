<!-- Mount the passive save indicator without a content view demanding a read. -->
<script lang="ts">
	import { setWhispering, type Whispering } from '$lib/whispering.svelte.js';
	import SaveStatus from '../SaveStatus.svelte';
	let { whispering, path }: { whispering: Whispering; path: string } = $props();
	// svelte-ignore state_referenced_locally
	setWhispering(whispering);
</script>

<SaveStatus {path} />
