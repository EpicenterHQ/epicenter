<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { type FocusItem, focusWord, STAGE_LABELS, STAGES } from '$lib/data.js';
	import type { Entries } from '$lib/entries.svelte.js';
	import { changeStage } from './word-actions.js';

	let { focus, entries }: { focus: readonly FocusItem[]; entries: Entries } = $props();
</script>

<h2 class="mb-3 text-sm font-semibold">Focus words</h2>
{#each focus as item (item.entryId)}
	{@const entry = focusWord(entries.words, item)}
	<div class="mb-4">
		<p class="font-medium">{item.text}</p>
		{#if entry}
			<div class="mt-1 flex flex-wrap gap-1" aria-label="Your stage for {item.text}">
				{#each STAGES as option}<Button size="sm" variant={entry.stage === option ? 'default' : 'outline'} aria-pressed={entry.stage === option} onclick={() => void changeStage(entries, entry.id, option)}>{STAGE_LABELS[option]}</Button>{/each}
			</div>
		{/if}
	</div>
{/each}
