<!--
	A chat's focus words and their stages. A stage press is saved at once,
	through the word's edit handle, so it keeps a note still being typed.
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
	{@const entry = focusWord(words.data ?? [], item)}
	<div class="mb-4">
		<p class="font-medium">{item.text}</p>
		{#if entry}
			{@const fileEdit = entries.edit(item.entryId)}
			{@const stage = fileEdit.content?.issues === null ? fileEdit.content.fields.stage : entry.row.fields.stage}
			<div class="mt-1 flex flex-wrap gap-1" aria-label="Your stage for {item.text}">
				{#each STAGES as option}
					<Button size="sm" variant={stage === option ? 'default' : 'outline'} aria-pressed={stage === option}  onclick={() => fileEdit.setStage(option)}>{STAGE_LABELS[option]}</Button>
				{/each}
			</div>
		{/if}
	</div>
{/each}
