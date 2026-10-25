<script lang="ts">
	import type { VocabFolder } from '../../../lib/data.js';
	import type { Entries } from '../../../lib/entries.svelte.js';
	import { setFolder } from '../../../lib/folder.js';
	import WordsView from '../WordsView.svelte';
	let { folder, entries }: { folder: VocabFolder; entries: Entries } = $props();
	// svelte-ignore state_referenced_locally
	setFolder(folder);
</script>
<WordsView {entries} starting={false} onStart={async () => false} />
