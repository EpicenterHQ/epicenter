<!--
	A word file that is not a valid word, open as its exact text. What is
	typed is held by the file's text edit handle, written a second after the last
	keystroke, when the learner leaves the text, when the page is hidden, and
	when the card goes away. The problems shown are the saved text's, read
	again after each write. Once the saved text is a valid word, "Show note
	and stage" closes the repair and the list shows it as a word.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { rowPath } from '$lib/data.js';
	import type { EntryRows, Entries } from '$lib/entries.svelte.js';
	import { describeFailure } from '$lib/failure.js';

	let { entries, id }: { entries: Entries; id: string } = $props();

	// svelte-ignore state_referenced_locally
	const path = rowPath('entries', id);
	// svelte-ignore state_referenced_locally
	const { repair } = entries;
	const row = createQuery(() => entries.entriesQuery((rows: EntryRows) => rows.find((candidate) => candidate.id === id)));
	const notText = $derived(row.data?.issues?.some((issue) => issue.kind === 'not-text') ?? false);
	// The text outlives the card; send what is typed now.
	onDestroy(() => void repair.save());
</script>

<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') void repair.save();
	}}
/>

<section class="space-y-2 rounded-lg border border-destructive/50 p-4 text-xs" aria-label="Repair {path}">
	{#if row.data && !notText}
		{@const stored = row.data}
		{@const textEdit = repair.view()}
		<p>
			<code>{path}</code>
			{stored.issues === null ? 'now reads as a word.' : 'is not a valid word, so its note and stage cannot be shown.'}
			Edit its text here; it is saved when you pause.
		</p>
		{#if textEdit}
			{@const text = textEdit.text}
			{#if text !== undefined}
				<Textarea
					class="min-h-32 font-mono text-xs"
					aria-label="File text for {path}"
					bind:value={() => text, (next) => textEdit.change(next)}
					onblur={() => void repair.save()}
				/>
			{/if}
		{/if}
		{#if repair.error && !repair.saving}
			<p role="alert" class="text-destructive">
				Not saved: {describeFailure(repair.error)}
				<Button variant="link" size="xs" class="h-auto p-0" onclick={() => void textEdit?.retry()}>Try again</Button>
			</p>
		{:else if repair.busy}
			<p role="status" class="text-muted-foreground">Saving…</p>
		{/if}
		{#if stored.issues}
			<ul role="alert" class="space-y-1 text-destructive" aria-label="Problems in the saved text">
				{#each stored.issues as issue, index (index)}
					<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
				{/each}
			</ul>
		{:else if !repair.busy}
			<Button size="sm" variant="outline" onclick={() => void repair.close()}>Show note and stage</Button>
		{/if}
	{:else if row.data || row.isSuccess}
		<p role="alert" class="text-destructive">
			<code>{path}</code> {row.data ? 'is no longer text' : 'is no longer here'}, so it cannot be shown here.
		</p>
		{#if repair.typed !== undefined}
			<pre class="max-h-32 overflow-auto whitespace-pre-wrap select-text" aria-label="Unsaved text">{repair.typed}</pre>
			<CopyButton size="sm" variant="outline" text={repair.typed}>Copy</CopyButton>
		{/if}
		<Button size="sm" variant="outline" onclick={() => repair.discard()}>Close</Button>
	{:else if row.isError}
		<p role="alert" class="text-destructive"><code>{path}</code> could not be read: {row.error.message}</p>
		<Button size="sm" variant="outline" onclick={() => void row.refetch()}>Read again</Button>
	{:else}
		<p>Reading <code>{path}</code>…</p>
	{/if}
</section>
