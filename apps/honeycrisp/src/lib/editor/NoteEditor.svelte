<!--
	The note's body in CodeMirror. It reads `body` (what the note shows: the
	text typed until its save answers, then the note) and calls `onEdit` with
	the whole body after each local change. It owns the editor's state (the
	cursor, the undo history) for as long as it is mounted: the mount reads
	nothing reactive, so nothing it is given recreates it, and a body that
	changes from elsewhere is applied as the smallest edits, outside Undo.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { createNoteEditor, type NoteEditor } from './note-editor.js';

	let {
		body,
		onEdit,
		autofocus = false,
		class: className = '',
	}: {
		/** The body as the note shows it now. */
		body: string;
		/** Write the whole body after a local change. */
		onEdit: (body: string) => void;
		/** Take focus once mounted. */
		autofocus?: boolean;
		class?: string;
	} = $props();

	let element: HTMLDivElement;
	let editor = $state.raw<NoteEditor>();

	// Mounted once: `onMount` tracks nothing, so no prop recreates the editor.
	onMount(() => {
		const created = createNoteEditor({ parent: element, body, onEdit: (next) => onEdit(next) });
		editor = created;
		if (autofocus) created.focus();
		return () => created.destroy();
	});

	// A local edit already shows what it wrote, so following it changes nothing.
	$effect(() => {
		const next = body;
		editor?.follow(next);
	});
</script>

<div bind:this={element} class={['note-editor h-full min-h-0 overflow-y-auto', className]}></div>

<style>
	.note-editor :global(.cm-editor) {
		height: 100%;
		font-size: 0.95rem;
	}
	.note-editor :global(.cm-editor.cm-focused) {
		outline: none;
	}
	.note-editor :global(.cm-content) {
		padding: 0.75rem 1rem 4rem;
		font-family: inherit;
		line-height: 1.6;
	}
</style>
