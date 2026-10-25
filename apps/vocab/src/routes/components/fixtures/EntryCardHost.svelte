<script lang="ts">
	import EntryCard from '../EntryCard.svelte';
	import type { cardProps } from '../card-props.test-support.svelte.js';
	let { card }: { card: ReturnType<typeof cardProps> } = $props();
	const entry = $derived(card.entries.words.find((word) => word.id === card.entry.id) ?? card.entry);
</script>
<EntryCard {entry} entries={card.entries} chosen={card.chosen} canChoose={card.canChoose} onToggle={card.onToggle} />
