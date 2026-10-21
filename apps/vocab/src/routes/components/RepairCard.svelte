<!--
	A word file that is not a valid word, open as its exact text. What is
	typed is held by the file's text edit handle, written a second after the last
	keystroke, even after the card goes away. FolderApp sends pending input
	when the page is hidden. The problems shown are the current document's,
	including unsaved changes. Once that document is a valid word, "Show note
	and stage" closes the repair and the list shows it as a word.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { untrack } from 'svelte';
	import { unsavedText } from '@epicenter/svelte/write-failure';
	import { rowPath } from '$lib/data.js';
	import type { Entries } from '$lib/entries.svelte.js';
	import { describeFailure } from '$lib/failure.js';

	let { entries, id }: { entries: Entries; id: string } = $props();

	// svelte-ignore state_referenced_locally
	const path = rowPath('entries', id);
	// svelte-ignore state_referenced_locally
	const { repair } = entries;
	const fileEdit = untrack(() => repair.view());
	const status = $derived(fileEdit?.readStatus);
	const pending = $derived(fileEdit?.pending);
	const unsaved = $derived(pending === undefined ? undefined : unsavedText(pending));
	const notText = $derived(status?.known === 'not-text');
</script>

<section class="space-y-2 rounded-lg border border-destructive/50 p-4 text-xs" aria-label="Repair {path}">
	{#if fileEdit?.markdown && !notText}
		{@const stored = fileEdit.markdown}
		<p>
			<code>{path}</code>
			{stored.issues === null ? 'now reads as a word.' : 'is not a valid word, so its note and stage cannot be shown.'}
			Edit its text here; it is saved when you pause.
		</p>
		{#if fileEdit}
			{@const text = fileEdit.text}
			{#if text !== undefined}
				<Textarea
					class="min-h-32 font-mono text-xs"
					aria-label="File text for {path}"
					bind:value={() => text, (next) => fileEdit.replaceText(next)}
				/>
			{/if}
		{/if}
		{#if pending?.error && !pending.saving}
			<p role="alert" class="text-destructive">
				Not saved: {describeFailure(pending.error)}
				<Button variant="link" size="xs" class="h-auto p-0" onclick={() => void fileEdit?.save()}>Try again</Button>
			</p>
		{:else if pending !== undefined}
			<p role="status" class="text-muted-foreground">Saving…</p>
		{/if}
		{#if stored.issues}
			<ul role="alert" class="space-y-1 text-destructive" aria-label="Problems in the current text">
				{#each stored.issues as issue, index (index)}
					<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
				{/each}
			</ul>
		{:else}
			<Button size="sm" variant="outline" onclick={() => void repair.close()}>Show note and stage</Button>
		{/if}
	{:else if notText || status?.known === 'missing'}
		<p role="alert" class="text-destructive">
			<code>{path}</code> {notText ? 'is no longer text' : 'is no longer here'}, so it cannot be shown here.
		</p>
		{#if unsaved !== undefined}
			<pre class="max-h-32 overflow-auto whitespace-pre-wrap select-text" aria-label="Unsaved text">{unsaved}</pre>
			<CopyButton size="sm" variant="outline" text={unsaved}>Copy</CopyButton>
		{/if}
		<Button size="sm" variant="outline" onclick={() => repair.discard()}>Close</Button>
	{:else if status?.error}
		<p role="alert" class="text-destructive"><code>{path}</code> could not be read: {status.error.message}</p>
		<Button size="sm" variant="outline" onclick={() => void fileEdit?.read()}>Read again</Button>
	{:else}
		<p>Reading <code>{path}</code>…</p>
	{/if}
</section>
