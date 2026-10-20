<!-- A folder editor window's page below its `<FolderApp>`: the editor inside the opened folder's context. -->
<script lang="ts">
	import type { FolderContext } from '@epicenter/svelte/folder';
	import FolderProvider from '@epicenter/svelte/folder-provider';
	import FolderEditor from '../FolderEditor.svelte';
	import type { ViewUpdater } from '../views.svelte';

	let { context, updateView }: { context: FolderContext<Record<never, never>>; updateView?: ViewUpdater } = $props();
</script>

<FolderProvider {context}><FolderEditor {updateView} /></FolderProvider>
<output aria-label="Save state">{context.saveState}</output>
