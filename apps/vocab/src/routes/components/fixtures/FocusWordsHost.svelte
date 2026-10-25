<script lang="ts">
	import type { FocusItem } from '../../../lib/data.js';
	import type { Entries } from '../../../lib/entries.svelte.js';
	import FocusWords from '../FocusWords.svelte';
	let { entries, focus }: { entries: Entries; focus: readonly FocusItem[] } = $props();
</script>
<FocusWords {entries} {focus} />
