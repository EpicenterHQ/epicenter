<script lang="ts">
	import type { SvelteFolder } from '@epicenter/svelte/folder';
	import { QueryClient, setQueryClientContext } from '@tanstack/svelte-query';
	import ConnectionList from './ConnectionList.svelte';
	import { connectionTables } from './connections.js';

	let { folder }: { folder: SvelteFolder<typeof connectionTables> } = $props();
	setQueryClientContext(new QueryClient());
</script>

<ConnectionList {folder} />
