<!-- A folder editor window's page below its `<FolderApp>`: the editor inside the opened folder's context. -->
<script lang="ts">
	import type { FolderContext } from '@epicenter/svelte/folder';
	import FolderEditor from '../FolderEditor.svelte';

	let { context }: { context: FolderContext<Record<never, never>> } = $props();
</script>

<FolderEditor {context} />
<output aria-label="Unsaved paths">{context.getStatus().unsaved.join(' ')}</output>
