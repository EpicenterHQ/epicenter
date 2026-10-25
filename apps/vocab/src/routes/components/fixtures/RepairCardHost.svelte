<script lang="ts">
	import type { VocabFolder } from '../../../lib/data.js';
	import type { Entries } from '../../../lib/entries.svelte.js';
	import { setFolder } from '../../../lib/folder.js';
	import RepairCard from '../RepairCard.svelte';
	let { folder, entries, id }: { folder: VocabFolder; entries: Entries; id: string } = $props();
	// svelte-ignore state_referenced_locally
	setFolder(folder);
</script>
<RepairCard {entries} {id} />
