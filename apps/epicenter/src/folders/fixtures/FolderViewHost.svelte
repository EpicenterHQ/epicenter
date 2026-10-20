<!-- A folder editor window's page below its `<FolderApp>`: the editor inside the opened folder's context. -->
<script lang="ts">
	import type { FolderContext } from '@epicenter/svelte/folder';
	import FolderProvider from '@epicenter/svelte/folder-provider';
	import FolderEditor from '../FolderEditor.svelte';

	let { context }: { context: FolderContext<Record<never, never>> } = $props();
</script>

<FolderProvider {context}><FolderEditor /></FolderProvider>
<output aria-label="Save state">{context.saveState}</output>
