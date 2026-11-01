<script lang="ts">
	import type { Entries, EntryList } from '../../../lib/entries.svelte.js';
	import { setEntryList } from '../../../lib/vocab.svelte.js';
	import WordsView from '../WordsView.svelte';
	let { entries, list }: { entries: Entries; list: EntryList } = $props();
	// svelte-ignore state_referenced_locally
	setEntryList(list);
</script>
<WordsView {entries} starting={false} onStart={async () => false} />
