<script lang="ts">
	import { QueryClientProvider, type QueryClient } from '@tanstack/svelte-query';
	import type { FocusItem } from '../../../lib/data.js';
	import type { Entries } from '../../../lib/entries.svelte.js';
	import FocusWords from '../FocusWords.svelte';

	let { client, entries, focus }: {
		client: QueryClient;
		entries: Entries;
		focus: readonly FocusItem[];
	} = $props();
</script>

<QueryClientProvider {client}>
	<FocusWords {entries} {focus} />
</QueryClientProvider>
