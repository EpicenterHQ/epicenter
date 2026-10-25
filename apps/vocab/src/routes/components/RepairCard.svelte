<script lang="ts">
	import { readRow, type Saved } from '@epicenter/folder/next';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { draft } from '@epicenter/svelte/folder-next';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { rowPath, vocabTables } from '$lib/data.js';
	import type { Entries } from '$lib/entries.svelte.js';
	import { getFolder } from '$lib/folder.js';

	let { entries, id }: { entries: Entries; id: string } = $props();
	const folder = getFolder();
	// svelte-ignore state_referenced_locally
	const path = rowPath('entries', id);
	const file = $derived(folder.file(path));
	const text = $derived(typeof file?.data === 'string' ? file.data : undefined);
	let lastSave: Saved | undefined;
	let closeProblem = $state('');
	const raw = draft(
		() => text?.replace(/\r\n?/g, '\n') ?? '',
		(value) => {
			closeProblem = '';
			return lastSave = folder.write(path, withFileNewlines(value, text ?? ''));
		},
	);
	const problems = $derived(readRow(raw.text, vocabTables.entries).issues);

	async function close() {
		const save = lastSave;
		if (await entries.repair.close(raw.text, save)) return;
		if (save && (await save).error !== null) return;
		const row = folder.tables.entries.row(id);
		if (row === undefined)
			closeProblem = 'The file is missing. Type to save it again.';
		else if (row.issues !== null)
			closeProblem = 'The saved file still has problems. Review its text and try again.';
	}
</script>

<section class="space-y-2 rounded-lg border border-destructive/50 p-4 text-xs" aria-label="Repair {path}">
	<p><code>{path}</code> {problems ? 'is not a valid word, so its note and stage cannot be shown.' : 'reads as a word in this editor and appears as one after saving.'} Changes are saved shortly after you type.</p>
	<Textarea class="min-h-32 font-mono text-xs" aria-label="File text for {path}" bind:value={raw.text} />
	{#if file?.readError}
		<div role="alert" class="text-destructive">Could not read <code>{path}</code>: {file.readError.message}
			<Button size="sm" variant="outline" onclick={() => folder.checkpoint()}>Read again</Button>
		</div>
	{/if}
	{#if problems}
		<ul role="alert" class="space-y-1 text-destructive" aria-label="Problems in the current text">
			{#each problems as issue, index (index)}<li>{'line' in issue && issue.line !== undefined ? `Line ${issue.line}: ` : ''}{issue.message}</li>{/each}
		</ul>
	{:else}
		<Button size="sm" variant="outline" onclick={() => void close()}>Show note and stage</Button>
	{/if}
	{#if closeProblem}<p role="alert" class="text-destructive">{closeProblem}</p>{/if}
</section>
