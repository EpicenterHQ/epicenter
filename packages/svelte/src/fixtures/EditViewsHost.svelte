<script lang="ts">
	import type { Folder } from '@epicenter/folder';
	import type { TObject, TString } from 'typebox';
	import { createRowEdit, createTextEdit } from '../edits.js';

	let { folder }: {
		folder: Folder<{ notes: TObject<{ title: TString }> }>;
	} = $props();
	let id = $state('a');
	const rowEdits = $derived([createRowEdit(folder.tables.notes, id), createRowEdit(folder.tables.notes, id)]);
	// svelte-ignore state_referenced_locally
	const textEdits = [createTextEdit(folder.files, 'b.md'), createTextEdit(folder.files, 'b.md')];
	const textEdit = $derived(createTextEdit(folder.files, `notes/${id}.md`));
	const text = $derived(textEdit.text);
</script>

<button onclick={() => id = id === 'a' ? 'c' : 'a'}>Switch address</button>

{#each rowEdits as rowEdit, i}
	{#if rowEdit.row?.issues === null}
		{@const row = rowEdit.row}
		<textarea aria-label={`Row ${i}`} bind:value={() => row.body, body => rowEdit.change({ body })}></textarea>
	{/if}
{/each}
{#each textEdits as textEdit, i}
	{@const text = textEdit.text}
	{#if text !== undefined}
		<textarea aria-label={`Text ${i}`} bind:value={() => text, value => textEdit.change(value)}></textarea>
	{/if}
{/each}

{#if text !== undefined}
	<textarea aria-label="Whole row text" bind:value={() => text, value => textEdit.change(value)}></textarea>
{/if}
<output aria-label="Shared pending">{textEdit.pending?.kind ?? 'saved'}</output>
