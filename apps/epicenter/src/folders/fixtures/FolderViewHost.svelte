<!-- One opened folder as the Folders window shows it: inside the window's query client. -->
<script lang="ts">
	import { QueryClientProvider, type QueryClient } from '@tanstack/svelte-query';
	import type { ComponentProps } from 'svelte';
	import FolderView from '../FolderView.svelte';

	let {
		client,
		...view
	}: { client: QueryClient } & ComponentProps<typeof FolderView> = $props();
</script>

<QueryClientProvider {client}><FolderView {...view} /></QueryClientProvider>
