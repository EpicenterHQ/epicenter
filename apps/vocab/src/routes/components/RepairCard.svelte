<!--
	A word file that is not a valid word, open as its exact text. What is
	typed is held by the file's text edit handle, written a second after the last
	keystroke, even after the card goes away. FolderApp sends pending input
	when the page is hidden. The problems shown are the current document's,
	including unsaved changes. Once that document is a valid word, "Show note
	and stage" closes the repair and the list shows it as a word.
-->
<script lang="ts">
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { toastOnError } from '@epicenter/ui/sonner';
	import { untrack } from 'svelte';
	import { rowPath } from '$lib/data.js';
	import type { Entries } from '$lib/entries.svelte.js';
	import { describeFailure } from '$lib/failure.js';

	let { entries, id }: { entries: Entries; id: string } = $props();

	// svelte-ignore state_referenced_locally
	const path = rowPath('entries', id);
	// svelte-ignore state_referenced_locally
	const { repair } = entries;
	const fileEdit = untrack(() => repair.view());

</script>

<section class="space-y-2 rounded-lg border border-destructive/50 p-4 text-xs" aria-label="Repair {path}">
	{#if fileEdit}
		{@const stored = fileEdit.content}
		{#if stored}
			<p>
				<code>{path}</code>
				{stored.issues === null ? 'now reads as a word.' : 'is not a valid word, so its note and stage cannot be shown.'}
				Edit its text here; it is saved when you pause.
			</p>
			<Textarea
				class="min-h-32 font-mono text-xs"
				aria-label="File text for {path}"
				bind:value={() => stored.text, (next) => toastOnError(fileEdit.replace(withFileNewlines(next, stored.text)), 'That change was not made')}
			/>
			{#if fileEdit.loadError}
				<p role="alert" class="text-sm text-destructive">{fileEdit.loadError.message}</p>
			{/if}
			{#if fileEdit.saveError}
				<p role="alert" class="text-destructive">Not saved: {describeFailure(fileEdit.saveError)}
					<Button variant="link" size="xs" onclick={() => void fileEdit.save()}>Try again</Button>
				</p>
			{:else if fileEdit.isDirty || fileEdit.isSaving}
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
		{:else if fileEdit.loadError}
			<p role="alert" class="text-destructive"><code>{path}</code> could not be read: {fileEdit.loadError.message}</p>
			<Button size="sm" variant="outline" onclick={() => void fileEdit.refresh()}>Read again</Button>
		{:else}
			<p>Reading <code>{path}</code>…</p>
		{/if}
	{:else}
		<p>Reading <code>{path}</code>…</p>
	{/if}
</section>
