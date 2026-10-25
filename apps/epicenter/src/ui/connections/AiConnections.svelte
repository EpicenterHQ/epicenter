<script lang="ts">
	import { openFolder } from '@epicenter/folder/next/tauri';
	import OpenFolder from '@epicenter/svelte/open-folder';
	import { QueryClient, setQueryClientContext } from '@tanstack/svelte-query';
	import ConnectionList from './ConnectionList.svelte';
	import { connectionTables } from './connections.js';

	const queryClient = new QueryClient();
	setQueryClientContext(queryClient);
</script>

<div class="grid gap-3 border-b p-3">
	<h2 class="font-medium">AI connections</h2>
	<OpenFolder open={() => openFolder({ tables: connectionTables })} holdWindowClose={false} class="min-h-24">
		{#snippet children(folder)}<ConnectionList {folder} />{/snippet}
	</OpenFolder>
</div>
