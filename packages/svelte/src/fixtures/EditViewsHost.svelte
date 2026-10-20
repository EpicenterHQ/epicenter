<script lang="ts">
	import type { Row } from '@epicenter/folder';
	import type { RowEdit, TextEdit } from '@epicenter/folder/edits';
	import { untrack } from 'svelte';
	import { createRowEdit, createTextEdit } from '../edits.js';

	let { edit, observed, textEdit, bytes }: {
		edit: RowEdit;
		observed: Row;
		textEdit: TextEdit;
		bytes: Uint8Array;
	} = $props();
	const rows = untrack(() => [
		createRowEdit(edit, () => observed),
		createRowEdit(edit, () => observed),
	]);
	const texts = untrack(() => [
		createTextEdit(textEdit, () => bytes),
		createTextEdit(textEdit, () => bytes),
	]);
</script>

{#each rows as row, i}
	<textarea aria-label={`Row ${i}`} bind:value={() => row.row.body, body => row.change({ body })}></textarea>
{/each}
{#each texts as text, i}
	<textarea aria-label={`Text ${i}`} bind:value={() => text.text, value => text.change(value)}></textarea>
{/each}
