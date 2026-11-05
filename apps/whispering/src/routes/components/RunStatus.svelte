<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { getLibrary, type Run } from '$lib/library.svelte.js';

	/**
	 * A request in this window and what became of it: its answer on the way,
	 * being saved, or why the request failed. Run again sends the same
	 * request. A save never fails: the folder keeps it until it lands.
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
	{:else}
		<p class="flex items-center gap-2 text-muted-foreground" role="status">
			<Spinner class="size-3.5" />
			{run.state.kind === 'running' ? 'Waiting for the answer…' : 'Saving the answer…'}
		</p>
	{/if}
</div>
