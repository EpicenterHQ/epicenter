<!--
	A word file that is not a valid word, open as its exact text. Each change
	goes into the repair's draft, written a second after the last keystroke,
	when the learner leaves the text, and when the card goes away; the issues
	are read live from what is typed. Once the text is a valid word, "Show note
	and stage" closes the repair and the list shows it as a word.
-->
<script lang="ts">
	import { parseRow } from '@epicenter/folder';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createQuery } from '@tanstack/svelte-query';
	import { useDebounce } from 'runed';
	import { onDestroy } from 'svelte';
	import { vocabFolder } from '$lib/data.js';
	import type { Entries } from '$lib/entries.svelte.js';

	let { entries, path }: { entries: Entries; path: string } = $props();

	const opened = createQuery(() => entries.textQuery(path));
	const saveLater = useDebounce(() => entries.saveRepair(), 1000);
	// runed's timer outlives the card; save now instead.
	onDestroy(() => void saveLater.runScheduledNow());
	/** The typed text not yet written, or the file's text as last read. */
	const text = $derived(opened.data?.kind === 'text' ? (entries.repairText ?? opened.data.file.text) : undefined);
	/** Why the text is not a word yet, read live from what is typed. */
	const issues = $derived(text === undefined ? undefined : (parseRow(vocabFolder.tables.entries, text).error ?? undefined));
</script>

<section class="space-y-2 rounded-lg border border-destructive/50 p-4 text-xs" aria-label="Repair {path}">
	{#if text !== undefined}
		<p>
			<code>{path}</code> is not a valid word, so its note and stage cannot be shown. Edit its text here; it
			is saved when you pause.
		</p>
		<Textarea
			class="min-h-32 font-mono text-xs"
			aria-label="File text for {path}"
			bind:value={
				() => text,
				(next) => {
					if (entries.inputText(path, next)) void saveLater();
				}
			}
			onblur={() => void saveLater.runScheduledNow()}
		/>
		{#if issues}
			<ul role="alert" class="space-y-1 text-destructive">
				{#each issues as issue, index (index)}
					<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
				{/each}
			</ul>
		{:else}
			<Button size="sm" variant="outline" onclick={() => void entries.closeRepair()}>Show note and stage</Button>
		{/if}
	{:else if opened.isError}
		<p role="alert" class="text-destructive"><code>{path}</code> could not be read: {opened.error.message}</p>
		<Button size="sm" variant="outline" onclick={() => void entries.closeRepair()}>Close</Button>
	{:else if opened.data}
		<p role="alert" class="text-destructive"><code>{path}</code> is no longer text, so it cannot be shown here.</p>
		<Button size="sm" variant="outline" onclick={() => void entries.closeRepair()}>Close</Button>
	{:else}
		<p>Reading <code>{path}</code>…</p>
	{/if}
</section>
