<script lang="ts">
	import type { Entries } from '../../../lib/entries.svelte.js';
	import WordsView from '../WordsView.svelte';
	let { entries }: { entries: Entries } = $props();
</script>
<WordsView view="device" {entries} starting={false} onStart={async () => false} />
