<!--
	The note's body in CodeMirror, over its repository editor. It owns the
	view's state (the cursor, the undo history) for as long as it is mounted;
	the editor it is given holds the draft, so nothing it is given recreates
	the view.
-->
<script lang="ts">
	import type { Editor } from '@epicenter/repository/api';
	import { onMount, untrack } from 'svelte';
	import { createNoteEditor, type NoteEditor } from './note-editor.js';

	let {
		editor,
		focusRequest = 0,
		class: className = '',
	}: {
		/** The note's editor; fixed for this view's life. */
		editor: Editor;
		/** Bumped to move focus into the editor. */
		focusRequest?: number;
		class?: string;
	} = $props();

	let element: HTMLDivElement;
	let view = $state.raw<NoteEditor>();

	onMount(() => {
		const created = createNoteEditor({ parent: element, editor: untrack(() => editor) });
		view = created;
		return () => created.destroy();
	});

	// Each request focuses the editor once it exists.
	$effect(() => {
		const target = view;
		if (focusRequest > 0) target?.focus();
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
