<!-- Hands the folder context it is mounted under to the test. -->
<script lang="ts">
	import { type FolderContext, getFolder } from '../folder-context.js';

	let { onContext }: { onContext: (context: FolderContext) => void } = $props();

	// svelte-ignore state_referenced_locally
	onContext(getFolder());
</script>
