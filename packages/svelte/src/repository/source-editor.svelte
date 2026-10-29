<!--
	A note in CodeMirror over its repository editor: the body by default, or
	the exact text when the editor was opened with `source: true`. The
	editor saves as the person types; this view shows where that stands.
	Typing the worker could not carry onto a change made in the same place
	pauses saving with both kept: the person keeps theirs or takes the other.
	A failed save keeps the typing, with Try again.

	The caller opens the editor and closes it, so it decides what to do with
	typing a close could not save.

	```svelte
	<SourceEditor {editor} check={(text) => app.check(text, { as: 'notes' })} />
	```
-->
<script lang="ts">
	import type { Editor, EditorState, TextStatus } from '@epicenter/repository/api';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { onMount, untrack } from 'svelte';
	import { createEditorView } from './codemirror.js';

	let {
		editor,
		check,
		label = 'Note',
		focusRequest = 0,
		class: className = '',
	}: {
		editor: Editor;
		/** Whether a text parses and fits its schema; for a source editor, shown as the person types. */
		check?: (text: string) => TextStatus;
		/** The editor's accessible name. */
		label?: string;
		/** Bumped to move focus into the editor. */
		focusRequest?: number;
		class?: string;
	} = $props();

	let element: HTMLDivElement;
	let view = $state.raw<ReturnType<typeof createEditorView>>();
	let saving = $state.raw<EditorState>(untrack(() => editor.state()));
	let status = $state.raw<TextStatus>();

	onMount(() => {
		const current = untrack(() => editor);
		const checking = untrack(() => check);
		const read = () => {
			saving = current.state();
			status = checking?.(current.draft());
		};
		const created = createEditorView({ parent: element, editor: current, label: untrack(() => label) });
		view = created;
		const stop = current.subscribe(read);
		read();
		return () => {
			stop();
			created.destroy();
		};
	});

	$effect(() => {
		const target = view;
		if (focusRequest > 0) target?.focus();
	});
</script>

<div class={['repository-source-editor flex min-h-0 flex-col', className]}>
	<div bind:this={element} class="min-h-0 flex-1 overflow-y-auto"></div>
	<div class="shrink-0 space-y-1 border-t px-3 py-2 text-xs" role="status" data-testid="editor-status" data-state={saving.status}>
		{#if status !== undefined && !status.parses}
			<p class="flex flex-wrap items-center gap-2">
				<Badge variant="destructive">Frontmatter doesn't parse (line {status.line})</Badge>
				<span class="text-muted-foreground">{status.message}</span>
			</p>
		{:else if status !== undefined && status.matches === false}
			<p><Badge variant="destructive">Doesn't match the schema</Badge></p>
		{/if}
		{#if saving.status === 'paused'}
			{@const theirs = saving.theirs}
			<p class="text-muted-foreground">Someone changed this in the same place you were typing. Saving waits until you choose.</p>
			<pre class="max-h-32 overflow-auto rounded bg-muted p-2" data-testid="editor-theirs">{theirs}</pre>
			<p class="flex gap-2">
				<Button size="sm" onclick={() => editor.resolve(editor.draft())}>Keep mine</Button>
				<Button size="sm" variant="outline" onclick={() => editor.resolve(theirs)}>Use theirs</Button>
			</p>
		{:else if saving.status === 'failed'}
			<p class="flex flex-wrap items-center gap-2 text-destructive">
				Not saved: {saving.error.message}
				<Button size="sm" variant="outline" onclick={() => editor.retry()}>Try again</Button>
			</p>
		{:else if saving.status === 'closed'}
			<p class="text-muted-foreground">Closed; this text is kept here but no longer saved.</p>
		{:else}
			<p class="text-muted-foreground">{saving.status === 'saving' ? 'Saving…' : 'Saved'}</p>
		{/if}
	</div>
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
