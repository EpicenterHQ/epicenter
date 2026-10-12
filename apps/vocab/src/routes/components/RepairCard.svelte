<!--
	A word file that is not a valid word, open as its exact text. Each change
	goes into the cached text and is written as typed, and the issues are read
	live from what is typed. Once the text is a valid word, "Show note and
	stage" closes the repair and the list shows it as a word.
-->
<script lang="ts">
	import { parseRow } from '@epicenter/folder';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createQuery } from '@tanstack/svelte-query';
	import { vocabFolder } from '$lib/data.js';
	import type { Entries } from '$lib/entries.svelte.js';

	let { entries, path }: { entries: Entries; path: string } = $props();

	const opened = createQuery(() => entries.textQuery(path));
	const text = $derived(opened.data?.kind === 'text' ? opened.data.file.text : undefined);
	/** Why the text is not a word yet, read live from what is typed. */
	const issues = $derived(text === undefined ? undefined : (parseRow(vocabFolder.tables.entries, text).error ?? undefined));
</script>

<section class="space-y-2 rounded-lg border border-destructive/50 p-4 text-xs" aria-label="Repair {path}">
	{#if text !== undefined}
		<p>
			<code>{path}</code> is not a valid word, so its note and stage cannot be shown. Edit its text here; each
			change is saved as typed.
		</p>
		<Textarea
			class="min-h-32 font-mono text-xs"
			aria-label="File text for {path}"
			bind:value={() => text, (next) => entries.inputText(path, next)}
		/>
		{#if issues}
			<ul role="alert" class="space-y-1 text-destructive">
				{#each issues as issue, index (index)}
					<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
				{/each}
			</ul>
		{:else}
			<Button size="sm" variant="outline" onclick={() => entries.closeRepair()}>Show note and stage</Button>
		{/if}
	{:else if opened.isError}
		<p role="alert" class="text-destructive"><code>{path}</code> could not be read: {opened.error.message}</p>
		<Button size="sm" variant="outline" onclick={() => entries.closeRepair()}>Close</Button>
	{:else if opened.data}
		<p role="alert" class="text-destructive"><code>{path}</code> is no longer text, so it cannot be shown here.</p>
		<Button size="sm" variant="outline" onclick={() => entries.closeRepair()}>Close</Button>
	{:else}
		<p>Reading <code>{path}</code>…</p>
	{/if}
</section>
