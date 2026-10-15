<!--
	A chat's focus words and their stages. A stage press is an edit like any
	other: it changes the word's draft, which is saved at once.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { createQuery } from '@tanstack/svelte-query';
	import { type FocusItem, focusWord, STAGE_LABELS, STAGES } from '$lib/data.js';
	import { type Entries, wordsOf } from '$lib/entries.svelte.js';

	let { focus, entries }: {
		focus: readonly FocusItem[];
		entries: Entries;
	} = $props();

	const words = createQuery(() => entries.entriesQuery(wordsOf));
</script>

<h2 class="mb-3 text-sm font-semibold">Focus words</h2>
{#each focus as item (item.entryId)}
	{@const listed = focusWord(words.data ?? [], item)}
	{@const entry = listed && entries.shown(listed)}
	<div class="mb-4">
		<p class="font-medium">{item.text}</p>
		{#if entry}
			<div class="mt-1 flex flex-wrap gap-1" aria-label="Your stage for {item.text}">
				{#each STAGES as stage}
					<Button size="sm" variant={entry.stage === stage ? 'default' : 'outline'} aria-pressed={entry.stage === stage} disabled={entries.isLocked(entry.id)} onclick={() => entries.setStage(entry.id, stage)}>{STAGE_LABELS[stage]}</Button>
				{/each}
			</div>
		{/if}
	</div>
{/each}
