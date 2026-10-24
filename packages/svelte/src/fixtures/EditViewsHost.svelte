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
	const text = $derived(snapshot.current.text);
</script>

<button onclick={() => (id = id === 'a' ? 'c' : 'a')}>Switch address</button>

{#each rowEdits as { document, snapshot }, i}
	{@const source = snapshot.current.text}
	{@const row = source === undefined ? undefined : folder.tables.notes.parse(source)}
	{#if row?.issues === null}
		<textarea aria-label="Row {i}" bind:value={() => row.body, (body) => document.patch({ body })}></textarea>
	{/if}
{/each}
{#each textEdits as { document, snapshot }, i}
	{@const text = snapshot.current.text}
	{#if text !== undefined}
		<textarea aria-label="Text {i}" bind:value={() => text, (value) => document.replace(value)}></textarea>
	{/if}
{/each}

{#if text !== undefined}
	<textarea aria-label="Whole row text" bind:value={() => text, (value) => textEdit.replace(value)}></textarea>
{/if}
<output aria-label="Shared pending">{snapshot.current.isDirty ? snapshot.current.text : 'saved'}</output>
<output aria-label="Shared document">{folder.tables.notes.document(id) === folder.tables.notes.document(id) ? 'one' : 'many'}</output>
