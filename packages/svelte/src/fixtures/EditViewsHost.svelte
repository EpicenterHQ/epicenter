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
	const content = $derived(textEdit.content);
</script>

<button onclick={() => (id = id === 'a' ? 'c' : 'a')}>Switch address</button>

{#each rowEdits as rowEdit, i}
	{@const row = rowEdit.content}
	{#if row && row.issues === null}
		<textarea aria-label="Row {i}" bind:value={() => row.body, (body) => rowEdit.change({ body })}></textarea>
	{/if}
{/each}
{#each textEdits as textEdit, i}
	{@const content = textEdit.content}
	{#if content}
		<textarea aria-label="Text {i}" bind:value={() => content.text, (value) => textEdit.replaceText(value)}></textarea>
	{/if}
{/each}

{#if content}
	<textarea aria-label="Whole row text" bind:value={() => content.text, (value) => textEdit.replaceText(value)}></textarea>
{/if}
<output aria-label="Shared pending">{textEdit.isDirty ? textEdit.content?.text : 'saved'}</output>
<output aria-label="Shared adapter">{rowEdits[0] === rowEdits[1] ? 'one' : 'many'}</output>
