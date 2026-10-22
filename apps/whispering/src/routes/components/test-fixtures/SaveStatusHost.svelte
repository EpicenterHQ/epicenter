<!-- Mount the passive save indicator without a content view demanding a read. -->
<script lang="ts">
	import { setFolder, type WhisperingContext } from '$lib/folder.js';
	import SaveStatus from '../SaveStatus.svelte';
	let { context, path }: { context: WhisperingContext; path: string } = $props();
	// svelte-ignore state_referenced_locally
	setFolder(context);
</script>

<SaveStatus {path} />
