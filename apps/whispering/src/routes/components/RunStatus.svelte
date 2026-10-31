<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { getLibrary, type Run } from '$lib/library.svelte.js';
	import { copyText } from './file-actions.js';

	/**
	 * A request in this window and what became of it: its answer on the way,
	 * being kept or why it was not, or why the request failed. An answer that
	 * was not kept is saved again only when asked, without another request;
	 * Run again sends the same request.
	 */
	let { run }: { run: Run } = $props();
	const library = getLibrary();

	async function runAgain() {
		const problem = await library.runAgain(run.key);
		if (problem) toast.error('It was not run again', { description: problem });
	}
</script>

<div class="flex flex-col gap-1.5 text-sm" data-testid="run-status" data-run-state={run.state.kind}>
	{#if run.state.kind === 'running' || (run.state.kind === 'unsaved' && run.state.message === undefined)}
		<p class="flex items-center gap-2 text-muted-foreground" role="status">
			<Spinner class="size-3.5" />
			{run.state.kind === 'running' ? 'Waiting for the answer…' : 'Saving the answer…'}
		</p>
	{:else if run.state.kind === 'unsaved'}
		{@const text = run.state.text}
		<p class="text-destructive" role="alert" data-testid="run-error">Answer not saved: {run.state.message}</p>
		<p class="max-h-24 overflow-y-auto rounded border bg-background p-2 whitespace-pre-wrap">{text}</p>
		<div class="flex items-center gap-1">
			<Button size="xs" onclick={() => void library.saveAgain(run.key)} data-testid="save-again">Save again</Button>
			<Button size="xs" variant="outline" onclick={() => void copyText(text, 'the answer')}>Copy</Button>
			<Button size="xs" variant="ghost" onclick={() => library.dismissRun(run.key)}>Discard</Button>
		</div>
	{:else}
		<p class="text-destructive" role="alert" data-testid="run-error">No answer was received: {run.state.message}</p>
		<div class="flex items-center gap-1">
			{#if run.noteId !== ''}
				<Button size="xs" onclick={() => void runAgain()} data-testid="run-again">Run again</Button>
			{/if}
			<Button size="xs" variant="ghost" onclick={() => library.dismissRun(run.key)} data-testid="dismiss-run">Dismiss</Button>
		</div>
	{/if}
</div>
