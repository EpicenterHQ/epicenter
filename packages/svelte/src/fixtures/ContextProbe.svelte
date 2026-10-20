<!-- Hands the opened folder context to the test. -->
<script lang="ts">
	import type { FolderContext } from '../folder-context.js';

	let { context, onContext }: {
		context: FolderContext;
		onContext: (context: FolderContext) => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	onContext(context);
</script>
