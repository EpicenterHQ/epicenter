<!--
	Mounts one real `EntryCard` inside the query client the layout supplies,
	with props a test can change in place.
-->
<script lang="ts">
	import { QueryClientProvider, type QueryClient } from '@tanstack/svelte-query';
	import EntryCard from '../EntryCard.svelte';
	import type { cardProps } from '../card-props.test-support.svelte.js';

	let { client, card }: { client: QueryClient; card: ReturnType<typeof cardProps> } = $props();
</script>

<QueryClientProvider {client}>
	{#key card.entry.id}
		<EntryCard
			entry={card.entry}
			entries={card.entries}
			chosen={card.chosen}
			canChoose={card.canChoose}
			onToggle={card.onToggle}
		/>
	{/key}
</QueryClientProvider>
