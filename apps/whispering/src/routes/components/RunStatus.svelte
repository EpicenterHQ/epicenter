<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from 'svelte-sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { getLibrary, type Run } from '$lib/library.svelte.js';

	/**
	 * A request in this window and what became of it: its answer on the way,
	 * being saved, why the request failed (Run again sends the same request),
	 * or why its answer was not saved (Save again writes it; nothing is sent).
	 */
	let { run }: { run: Run } = $props();
	const library = getLibrary();

	async function runAgain() {
		const problem = await library.runAgain(run.key);
		if (problem) toast.error('It was not run again', { description: problem });
	}
</script>

<div class="flex flex-col gap-1.5 text-sm" data-testid="run-status" data-run-state={run.state.kind}>
	{#if run.state.kind === 'failed'}
		<p class="text-destructive" role="alert" data-testid="run-error">No answer was received: {run.state.message}</p>
		<div class="flex items-center gap-1">
			{#if run.noteId !== ''}
				<Button size="xs" onclick={() => void runAgain()} data-testid="run-again">Run again</Button>
			{/if}
			<Button size="xs" variant="ghost" onclick={() => library.dismissRun(run.key)} data-testid="dismiss-run">Dismiss</Button>
		</div>
	{:else if run.state.kind === 'unsaved'}
		<p class="text-destructive" role="alert" data-testid="run-unsaved">The answer arrived but was not saved: {run.state.message}</p>
		<p class="max-h-32 overflow-y-auto whitespace-pre-wrap rounded border p-2 text-xs" data-testid="run-unsaved-text">{run.state.text}</p>
		<div class="flex items-center gap-1">
			<Button size="xs" onclick={() => void runAgain()} data-testid="save-again">Save again</Button>
			<Button size="xs" variant="ghost" onclick={() => library.dismissRun(run.key)} data-testid="dismiss-run">Discard answer</Button>
		</div>
	{:else}
		<p class="flex items-center gap-2 text-muted-foreground" role="status">
			<Spinner class="size-3.5" />
			{run.state.kind === 'running' ? 'Waiting for the answer…' : 'Saving the answer…'}
		</p>
	{/if}
</div>
