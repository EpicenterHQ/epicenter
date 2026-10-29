<!--
	A note in CodeMirror over its repository editor: the exact text by
	default, or the body (`shows="body"`). Both are views of one editor, so a
	note's body and source can be open at once. The editor saves as the
	person types; this view shows where that stands.
	Typing the worker could not carry onto a change made in the same place
	pauses saving with both kept: the person keeps theirs or takes the other.
	A failed save keeps the typing, with Try again. Given a `check`, the
	status says as the person types whether the frontmatter parses and the
	note fits its schema; given the note's `state`, it says when the text is
	saved here but held, not sent, and why.

	The caller opens the editor and closes it, so it decides what to do with
	typing a close could not save.

	```svelte
	<SourceEditor {editor} check={(text) => app.check(text, { as: 'notes' })} state={note.state} />
	<SourceEditor {editor} shows="body" />
	```
-->
<script lang="ts">
	import type { Editor, FileStatus, TextStatus } from '@epicenter/repository';
	import { onMount, untrack } from 'svelte';
	import { createEditorView, type Shows } from './codemirror.js';
	import EditorStatus from './editor-status.svelte';

	let {
		editor,
		check,
		// Not named `state`, which would make `$state` read as a store.
		state: noteState,
		shows = 'source',
		label = 'Note',
		focusRequest = 0,
		class: className = '',
	}: {
		editor: Editor;
		/** Whether the note's exact text parses and fits its schema, shown as the person types. */
		check?: (text: string) => TextStatus;
		/** The note's state as the repository lists it: a held note says why it is not sent. */
		state?: FileStatus;
		/** The exact text, or the body under the frontmatter. */
		shows?: Shows;
		/** The editor's accessible name. */
		label?: string;
		/** Bumped to move focus into the editor. */
		focusRequest?: number;
		class?: string;
	} = $props();

	let element: HTMLDivElement;
	let view = $state.raw<ReturnType<typeof createEditorView>>();
	onMount(() => {
		const created = createEditorView({ parent: element, editor: untrack(() => editor), shows: untrack(() => shows), label: untrack(() => label) });
		view = created;
		return () => created.destroy();
	});

	$effect(() => {
		const target = view;
		if (focusRequest > 0) target?.focus();
	});
</script>

<div class={['repository-source-editor flex min-h-0 flex-col', className]}>
	<div bind:this={element} class="min-h-0 flex-1 overflow-y-auto"></div>
	<EditorStatus {editor} {check} state={noteState} {shows} />
</div>

<style>
	.repository-source-editor :global(.cm-editor) {
		height: 100%;
		font-size: 0.85rem;
	}
	.repository-source-editor :global(.cm-editor.cm-focused) {
		outline: none;
	}
	.repository-source-editor :global(.cm-content) {
		padding: 0.75rem 0;
		font-family: var(--font-mono, ui-monospace, monospace);
	}
</style>
