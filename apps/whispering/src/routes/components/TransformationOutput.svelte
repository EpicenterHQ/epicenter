<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { getLibrary, type TextRunNote, type TransformationRunNote } from '$lib/library.svelte.js';
	import { confirmDelete, copyText, formatTime, titleOf } from './file-actions.js';

	/**
	 * One transformation result. It is its own note, made when its answer
	 * arrived: what it shows comes from that note, so it reads the same after
	 * the transformation, or the transcript or pasted text it was made from,
	 * has changed or gone.
	 */
	let { output, naming }: {
		/** A result on a transcript, from `transformation_runs/`, or on pasted text, from `text_runs/`. */
		output:
			| { readonly source: 'transcript'; readonly note: TransformationRunNote }
			| { readonly source: 'text'; readonly note: TextRunNote };
		/** Which side of the result to name: the transformation that made it, or what it was made from. */
		naming: 'transformation' | 'source';
	} = $props();
	const library = getLibrary();

	const note = $derived(output.note);
	const collection = $derived(output.source === 'transcript' ? 'transformation_runs' : 'text_runs');
	const recording = $derived(
		output.source === 'transcript'
			? library.entries.find((item) => item.id === output.note.recordingId)
			: undefined,
	);
	const heading = $derived.by(() => {
		if (naming === 'transformation') return note.transformationTitle;
		if (output.source === 'text') return 'Pasted text';
		if (recording) return titleOf(recording);
		return `Recording ${output.note.recordingId} (no longer listed)`;
	});
</script>

<article class="rounded border bg-muted/30 p-3 text-sm" data-testid="transformation-result" data-result-source={output.source}>
	<header class="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
		<span class="font-medium">{heading}</span>
		{#if output.source === 'text' && naming === 'source' && note.input}
			<span class="min-w-0 flex-1 truncate text-muted-foreground" title={note.input}>{note.input.trim()}</span>
		{/if}
	</header>
	<p class="whitespace-pre-wrap" data-testid="result-text">{note.body.trim() || '(empty result)'}</p>
	<footer class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
		<span>{formatTime(note.createdAt) || 'Unknown time'} · {note.model}</span>
		<span class="ml-auto flex items-center gap-1">
			<Button size="xs" variant="ghost" onclick={() => void copyText(note.body, 'the result')}>Copy</Button>
			<Button size="xs" variant="ghost-destructive" onclick={() => confirmDelete(library, { collection, id: note.id })}>Delete</Button>
		</span>
	</footer>
</article>
