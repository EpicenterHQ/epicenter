<script lang="ts">
	import type { Folder } from '@epicenter/folder';
	import type { TObject, TString } from 'typebox';
	import { reactiveDocument } from '../document.js';

	let { folder }: {
		folder: Folder<{ notes: TObject<{ title: TString }> }>;
	} = $props();
	let id = $state('a');
	const rowEdits = $derived([reactiveDocument(folder.tables.notes.document(id)), reactiveDocument(folder.tables.notes.document(id))]);
	// svelte-ignore state_referenced_locally
	const textEdits = [reactiveDocument(folder.files.document('b.md')), reactiveDocument(folder.files.document('b.md'))];
	const textEdit = $derived(reactiveDocument(folder.files.document(`notes/${id}.md`)));
	const content = $derived(textEdit.content);
</script>

<button onclick={() => (id = id === 'a' ? 'c' : 'a')}>Switch address</button>

{#each rowEdits as rowEdit, i}
	{@const row = rowEdit.content}
	{#if row && row.issues === null}
		<textarea aria-label="Row {i}" bind:value={() => row.body, (body) => rowEdit.patch({ body })}></textarea>
	{/if}
{/each}
{#each textEdits as textEdit, i}
	{@const content = textEdit.content}
	{#if content}
		<textarea aria-label="Text {i}" bind:value={() => content.text, (value) => textEdit.replace(value)}></textarea>
	{/if}
{/each}

{#if content}
	<textarea aria-label="Whole row text" bind:value={() => content.text, (value) => textEdit.replace(value)}></textarea>
{/if}
<output aria-label="Shared pending">{textEdit.isDirty ? textEdit.content?.text : 'saved'}</output>
<output aria-label="Shared document">{folder.tables.notes.document(id) === folder.tables.notes.document(id) ? 'one' : 'many'}</output>
