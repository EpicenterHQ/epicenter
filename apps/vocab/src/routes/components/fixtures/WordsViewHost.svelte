<script lang="ts">
	import { QueryClientProvider, type QueryClient } from '@tanstack/svelte-query';
	import type { Entries } from '../../../lib/entries.svelte.js';
	import WordsView from '../WordsView.svelte';

	let { client, entries }: { client: QueryClient; entries: Entries } = $props();
</script>

<QueryClientProvider {client}>
	<WordsView {entries} starting={false} onStart={async () => false} />
</QueryClientProvider>
