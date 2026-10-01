<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import type { createEntriesState } from '$lib/entries.svelte.js';

	let { focus, entries }: {
		focus: readonly { entryId: string; text: string }[];
		entries: ReturnType<typeof createEntriesState>;
	} = $props();
	const stages = [
		{ value: 'new', label: 'New' },
		{ value: 'recognized', label: 'Recognize' },
		{ value: 'understood', label: 'Understand' },
		{ value: 'usable', label: 'Use' },
	] as const;
</script>

<h2 class="mb-3 text-sm font-semibold">Focus words</h2>
{#each focus as item (item.entryId)}
	{@const entry = entries.entries.find((entry) => entry.id === item.entryId)}
	<div class="mb-4">
		<p class="font-medium">{item.text}</p>
		{#if entry}
			<div class="mt-1 flex flex-wrap gap-1" aria-label="Your stage for {item.text}">
				{#each stages as stage}
					<Button size="sm" variant={entry.stage === stage.value ? 'default' : 'outline'} aria-pressed={entry.stage === stage.value} onclick={() => entries.setStage(entry.id, stage.value)}>{stage.label}</Button>
				{/each}
			</div>
		{/if}
	</div>
{/each}
