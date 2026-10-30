<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { getWhispering, type TextRunEntry, type TransformationRunEntry } from '$lib/whispering.svelte.js';
	import { confirmDelete, copyText, formatTime, recordingTitle } from './file-actions.js';
	import ResultStatus from './ResultStatus.svelte';

	/**
	 * One transformation result. It is its own file, written when the run
	 * started: what it shows comes from that file, so it reads the same after
	 * the transformation, or the transcript or pasted text it was made from,
	 * has changed or gone. A file with no answer yet says why.
	 */
	let { output, naming, onOpenFile }: {
		/** A result on a transcript, from `transformation_runs/`, or on pasted text, from `text_runs/`. */
		output:
			| { readonly source: 'transcript'; readonly entry: TransformationRunEntry }
			| { readonly source: 'text'; readonly entry: TextRunEntry };
		/** Which side of the result to name: the transformation that made it, or what it was made from. */
		naming: 'transformation' | 'source';
		onOpenFile: (path: string) => void;
	} = $props();
	const whispering = getWhispering();

	const recording = $derived(
		output.source === 'transcript'
			? whispering.entries.find((item) => item.stem === output.entry.row.fields.recordingId)
			: undefined,
	);
	const heading = $derived.by(() => {
		if (naming === 'transformation') return output.entry.row.fields.transformationTitle;
		if (output.source === 'text') return 'Pasted text';
		if (recording) return recordingTitle(recording);
		return `Recording ${output.entry.row.fields.recordingId} (no longer in the folder)`;
	});

	const progress = $derived(whispering.resultState(output.entry.path, output.entry.row.body));
</script>

<article class="rounded border bg-muted/30 p-3 text-sm" data-testid="transformation-result" data-result-source={output.source}>
	<header class="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
		<span class="font-medium">{heading}</span>
		{#if output.source === 'text' && naming === 'source' && output.entry.row.fields.input}
			<span class="min-w-0 flex-1 truncate text-muted-foreground" title={output.entry.row.fields.input}>{output.entry.row.fields.input.trim()}</span>
		{/if}
	</header>
	{#if progress.kind === 'answered'}
		<p class="whitespace-pre-wrap">{output.entry.row.body.trim() || '(empty result)'}</p>
	{:else}
		<ResultStatus path={output.entry.path} result={progress} onDelete={() => void confirmDelete(whispering, output.entry.path)} />
	{/if}
	<footer class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
		<span>{formatTime(output.entry.row.fields.createdAt) || 'Unknown time'} · {output.entry.row.fields.model}</span>
		<Button size="xs" variant="ghost" onclick={() => onOpenFile(output.entry.path)}>
			<code class="font-mono">{output.entry.path}</code>
		</Button>
		<span class="ml-auto flex items-center gap-1">
			{#if progress.kind === 'answered'}
				<Button size="xs" variant="ghost" onclick={() => void copyText(output.entry.row.body, 'the result')}>Copy</Button>
			{/if}
			<Button size="xs" variant="ghost-destructive" onclick={() => void confirmDelete(whispering, output.entry.path)}>Delete</Button>
		</span>
	</footer>
</article>
