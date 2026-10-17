<!-- A component inside `<FolderApp>`: it reads the opened folder with `getFolder()` and hands it to the test. -->
<script lang="ts">
	import { getFolder, type FolderContext } from '../folder-context.js';

	let { onFolder }: { onFolder: (context: FolderContext) => void } = $props();
	const context = getFolder();
	// svelte-ignore state_referenced_locally
	onFolder(context);
</script>

<p data-testid="opened">{context.folder.id}</p>
