<script lang="ts">
	import { readRow } from '@epicenter/folder';
	import { fileDraft } from '@epicenter/svelte/folder';
	import RowIssues from '@epicenter/svelte/row-issues';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
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
	let closeProblem = $state('');
	const raw = fileDraft(folder, path);
	const problems = $derived(readRow(raw.value, vocabTables.entries).issues);

	async function close() {
		closeProblem = '';
		const value = raw.value;
		if ((await raw.land()).error || entries.repair.open !== id || raw.value !== value) return;
		if (entries.repair.close(value)) return;
		const row = folder.tables.entries.row(id);
		if (row === undefined)
			closeProblem = 'The file is missing. Type to save it again.';
		else if (row.issues !== null)
			closeProblem = 'The saved file still has problems. Review its text and try again.';
	}
</script>

<section class="space-y-2 rounded-lg border border-destructive/50 p-4 text-xs" aria-label="Repair {path}">
	<p><code>{path}</code> {problems ? 'is not a valid word, so its note and stage cannot be shown.' : 'reads as a word in this editor and appears as one after saving.'} Changes are saved shortly after you type.</p>
	<Textarea class="min-h-32 font-mono text-xs" aria-label="File text for {path}" bind:value={raw.value} oninput={() => closeProblem = ''} />
	<UnsavedEdit draft={raw} />
	{#if file?.readError}
		<div role="alert" class="text-destructive">Could not read <code>{path}</code>: {file.readError.message}
			<Button size="sm" variant="outline" onclick={() => void folder.refresh()}>Read again</Button>
		</div>
	{/if}
	{#if problems}
		<div role="alert" class="text-destructive [&_ul]:space-y-1" aria-label="Problems in the current text"><RowIssues issues={problems} /></div>
	{:else}
		<Button size="sm" variant="outline" onclick={() => void close()}>Show note and stage</Button>
	{/if}
	{#if closeProblem}<p role="alert" class="text-destructive">{closeProblem}</p>{/if}
</section>
