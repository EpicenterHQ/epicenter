<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import type { TextFileEditor, TodoEditor } from '$lib/editor.svelte.js';

	let { editor, onDiscardRemoved }: {
		editor: TodoEditor | TextFileEditor;
		onDiscardRemoved: () => void;
	} = $props();
</script>

<!-- One editor's save state, including the conflict choice that keeps or replaces the input. -->
<div class="flex min-h-9 flex-wrap items-center gap-2 border-b px-4 py-1.5 text-xs">
	{#if editor.saveState.kind === 'saving'}
		<span class="text-muted-foreground">Saving…</span>
	{:else if editor.saveState.kind === 'failed'}
		<span class="text-destructive" role="alert">Not saved: {editor.saveState.message}</span>
		<Button size="xs" variant="outline" onclick={() => void editor.retry()}>Try again</Button>
	{:else if editor.saveState.kind === 'conflict'}
		<span class="text-destructive" role="alert">
			{editor.saveState.current
				? 'This file changed elsewhere. Your edits are kept here and not saved.'
				: 'This file was removed elsewhere. Your edits are kept here and not saved.'}
		</span>
		{#if editor.saveState.current}
			<Button size="xs" variant="outline" onclick={() => editor.loadSaved()}>
				Discard mine and load saved
			</Button>
			<Button size="xs" onclick={() => void editor.keepMine()}>Save mine over it</Button>
		{:else}
			<Button size="xs" variant="outline" onclick={onDiscardRemoved}>Discard mine</Button>
		{/if}
	{:else if editor.dirty}
		<span class="text-muted-foreground">Unsaved typing</span>
	{:else}
		<span class="text-muted-foreground">Saved to <code class="font-mono">{editor.path}</code></span>
	{/if}
	{#if editor.refusal}
		<span class="text-warning">Change refused: {editor.refusal}</span>
	{/if}
</div>
