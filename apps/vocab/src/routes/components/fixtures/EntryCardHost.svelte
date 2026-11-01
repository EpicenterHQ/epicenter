<script lang="ts">
	import type { EntryList } from '../../../lib/entries.svelte.js';
	import { setEntryList } from '../../../lib/vocab.svelte.js';
	import EntryCard from '../EntryCard.svelte';
	import type { cardProps } from '../card-props.test-support.svelte.js';
	let { card, list }: { card: ReturnType<typeof cardProps>; list: EntryList } = $props();
	// svelte-ignore state_referenced_locally
	setEntryList(list);
	const entry = $derived(card.entries.words.find((word) => word.id === card.entry.id) ?? card.entry);
</script>
<EntryCard {entry} entries={card.entries} chosen={card.chosen} canChoose={card.canChoose} onToggle={card.onToggle} />
