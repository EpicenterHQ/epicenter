<!--
	The note's body in CodeMirror. It takes the body as a source to read,
	follow, and write, and owns the editor's state (the cursor, the undo
	history) for as long as it is mounted; nothing it is given recreates it.
-->
<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { createNoteEditor, type NoteEditor } from './note-editor.js';

	export type BodySource = {
		/** The body as the note shows it now. */
		read(): string;
		/** Call back whenever `read` may answer differently. */
		subscribe(onChange: () => void): () => void;
		/** Write the whole body after a local change. */
		edit(body: string): void;
	};

	let {
		source,
		focusRequest = 0,
		class: className = '',
	}: {
		source: BodySource;
		/** Bumped to move focus into the editor. */
		focusRequest?: number;
		class?: string;
	} = $props();

	let element: HTMLDivElement;
	let editor = $state.raw<NoteEditor>();

	onMount(() => {
		const body = untrack(() => source);
		let writing = false;
		const created = createNoteEditor({
			parent: element,
			body: body.read(),
			onEdit(next) {
				writing = true;
				try {
					body.edit(next);
				} finally {
					writing = false;
				}
			},
		});
		// A write's own echo arrives while it is being made; the editor already shows it.
		const stop = body.subscribe(() => {
			if (!writing) created.follow(body.read());
		});
		editor = created;
		return () => {
			stop();
			created.destroy();
		};
	});

	// Each request focuses the editor once it exists.
	$effect(() => {
		const target = editor;
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
