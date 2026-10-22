<script lang="ts">
	import type { Folder } from '@epicenter/folder';
	import type { TObject, TString } from 'typebox';
	import { liveSnapshot } from '../snapshot.js';

	let { folder }: {
		folder: Folder<{ notes: TObject<{ title: TString }> }>;
	} = $props();
	let id = $state('a');
	const rowEdits = $derived([0, 1].map(() => {
		const document = folder.tables.notes.document(id);
		return { document, snapshot: liveSnapshot(document) };
	}));
	// svelte-ignore state_referenced_locally
	const textEdits = [0, 1].map(() => {
		const document = folder.files.document('b.md');
		return { document, snapshot: liveSnapshot(document) };
	});
	const textEdit = $derived(folder.files.document(`notes/${id}.md`));
	const snapshot = $derived(liveSnapshot(textEdit));
	const content = $derived(snapshot.current.content);
</script>

<button onclick={() => (id = id === 'a' ? 'c' : 'a')}>Switch address</button>

{#each rowEdits as { document, snapshot }, i}
	{@const row = snapshot.current.content}
	{#if row && row.issues === null}
		<textarea aria-label="Row {i}" bind:value={() => row.body, (body) => document.patch({ body })}></textarea>
	{/if}
{/each}
{#each textEdits as { document, snapshot }, i}
	{@const content = snapshot.current.content}
	{#if content}
		<textarea aria-label="Text {i}" bind:value={() => content.text, (value) => document.replace(value)}></textarea>
	{/if}
{/each}

{#if content}
	<textarea aria-label="Whole row text" bind:value={() => content.text, (value) => textEdit.replace(value)}></textarea>
{/if}
<output aria-label="Shared pending">{snapshot.current.isDirty ? snapshot.current.content?.text : 'saved'}</output>
<output aria-label="Shared document">{folder.tables.notes.document(id) === folder.tables.notes.document(id) ? 'one' : 'many'}</output>
