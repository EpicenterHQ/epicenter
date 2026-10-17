<!-- The whole Todos view as the page mounts it: inside the folder's provider, with the tooltip provider the layout adds. -->
<script lang="ts">
	import FolderProvider from '@epicenter/svelte/folder-provider';
	import type { TodosFolder } from '$lib/todos.svelte.js';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import TodosView from '../TodosView.svelte';

	let { opened }: { opened: TodosFolder } = $props();
</script>

<Tooltip.Provider><FolderProvider context={opened}><TodosView /></FolderProvider></Tooltip.Provider>
