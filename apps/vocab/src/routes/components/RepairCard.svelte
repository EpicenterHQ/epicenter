<!--
	A word note that does not read, repaired as text (`NoteRepair`): what is
	wrong shows as the learner types, and Save repair writes the fixed text
	(`replace`); the card closes once it reads as a word again.
-->
<script lang="ts">
	import NoteRepair from '@epicenter/svelte/note-repair';
	import { Button } from '@epicenter/ui/button';
	import { vocab } from '$lib/contract.js';
	import type { Entries } from '$lib/entries.svelte.js';

	let { entries, id }: { entries: Entries; id: string } = $props();
	const note = $derived(entries.list.invalid.find((candidate) => candidate.id === id));
</script>

<section class="flex flex-col gap-2 rounded-lg border border-destructive/50 p-4 text-xs" aria-label="Repair entries/{id}.md">
	{#if note}
		<p><code>{note.path}</code> is not a valid word, so its note and stage cannot be shown. Fix its text and save it.</p>
		<NoteRepair contract={vocab} {note} replace={(text) => entries.list.replace({ id }, text)} onRepaired={() => entries.repair.close()} />
	{:else}
		<p>
			<code>entries/{id}.md</code>
			{entries.list.get({ id }) ? 'reads as a word now.' : 'is no longer here.'}
		</p>
		<Button size="sm" variant="outline" class="self-start" onclick={() => entries.repair.close()}>Close</Button>
	{/if}
</section>
