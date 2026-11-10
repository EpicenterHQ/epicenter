<!-- A word's answer: its reading, its meaning, and its examples, one per line. -->
<script lang="ts">
	import type { Word } from '../../../epicenter.js';
	import { langOf } from './text.js';

	let { word }: { word: Pick<Word, 'reading' | 'meaning' | 'body'> } = $props();

	const examples = $derived(
		word.body
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line !== ''),
	);
</script>

<div class="flex w-full flex-col items-center gap-3">
	{#if word.reading}
		<p class="text-2xl text-muted-foreground">{word.reading}</p>
	{/if}
	{#if word.meaning}
		<p class="text-xl text-balance">{word.meaning}</p>
	{/if}
	{#if examples.length > 0}
		<ul class="mt-2 w-full max-w-md space-y-2 border-t pt-4 text-left text-lg leading-relaxed">
			{#each examples as example, index (index)}
				<li lang={langOf(example)}>{example}</li>
			{/each}
		</ul>
	{/if}
</div>
