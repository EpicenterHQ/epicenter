<script lang="ts">
	import type { Folder } from '@epicenter/folder';
	import type { TObject, TString } from 'typebox';
	import { createFileEdit } from '../edits.js';

	let { folder }: {
		folder: Folder<{ notes: TObject<{ title: TString }> }>;
	} = $props();
	let id = $state('a');
	const rowEdits = $derived([createFileEdit(folder.tables.notes.edit(id)), createFileEdit(folder.tables.notes.edit(id))]);
	// svelte-ignore state_referenced_locally
	const textEdits = [createFileEdit(folder.files.edit('b.md')), createFileEdit(folder.files.edit('b.md'))];
	const textEdit = $derived(createFileEdit(folder.files.edit(`notes/${id}.md`)));
	const text = $derived(textEdit.text);
</script>

<button onclick={() => id = id === 'a' ? 'c' : 'a'}>Switch address</button>

{#each rowEdits as rowEdit, i}
	{@const row = rowEdit.markdown}
	{#if row && row.issues === null}
		<textarea aria-label={`Row ${i}`} bind:value={() => row.body, body => rowEdit.change({ body })}></textarea>
	{/if}
{/each}
{#each textEdits as textEdit, i}
	{@const text = textEdit.text}
	{#if text !== undefined}
		<textarea aria-label={`Text ${i}`} bind:value={() => text, value => textEdit.replaceText(value)}></textarea>
	{/if}
{/each}

{#if text !== undefined}
	<textarea aria-label="Whole row text" bind:value={() => text, value => textEdit.replaceText(value)}></textarea>
{/if}
<output aria-label="Shared pending">{textEdit.pending?.text ?? 'saved'}</output>
