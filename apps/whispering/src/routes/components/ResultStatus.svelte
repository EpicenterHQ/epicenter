<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { getWhispering, type ResultState } from '$lib/whispering.svelte.js';
	import { copyText } from './file-actions.js';

	/**
	 * A result file with no answer in it: its request running, its answer
	 * being written, why its request failed, or unfinished. Running it again
	 * sends the same request and writes the answer into the same file; deleting
	 * the file discards it.
	 */
	let {
		path,
		result,
		onDelete,
		audioAbsent = false,
	}: {
		path: string;
		result: Exclude<ResultState, { kind: 'answered' }>;
		onDelete: () => void;
		/** The recording's audio is not in this device's folder, so nothing can be sent again from here. */
		audioAbsent?: boolean;
	} = $props();
	const whispering = getWhispering();

	async function runAgain() {
		const problem = await whispering.runAgain(path);
		if (problem) toast.error('It was not run again', { description: problem });
	}
</script>

<div class="flex flex-col gap-1.5 text-sm" data-testid="result-status" data-result-state={result.kind}>
	{#if result.kind === 'running' || (result.kind === 'writing' && result.message === undefined)}
		<p class="flex items-center gap-2 text-muted-foreground" role="status">
			<Spinner class="size-3.5" />
			{result.kind === 'running' ? 'Waiting for the answer…' : 'Writing the answer…'}
		</p>
	{:else if result.kind === 'writing'}
		{@const text = result.text}
		<p class="text-destructive" role="alert">
			The answer arrived, but its file could not be written: {result.message} Whispering keeps trying while this window is
			open.
		</p>
		<p class="max-h-24 overflow-y-auto rounded border bg-background p-2 whitespace-pre-wrap">{text}</p>
		<div>
			<Button size="xs" variant="outline" onclick={() => void copyText(text, 'the answer')}>Copy</Button>
		</div>
	{:else}
		{#if result.kind === 'failed'}
			<p class="text-destructive" role="alert" data-testid="result-error">No answer was received: {result.message}</p>
		{:else}
			<p class="text-muted-foreground" role="status">Unfinished: no answer was written to this file.</p>
		{/if}
		<div class="flex items-center gap-1">
			<Button
				size="xs"
				disabled={audioAbsent}
				tooltip={audioAbsent ? 'This recording’s audio isn’t on this device.' : undefined}
				onclick={() => void runAgain()}
				data-testid="run-again">Run again</Button
			>
			<Button size="xs" variant="ghost-destructive" onclick={onDelete} data-testid="delete-unfinished">Delete</Button>
		</div>
	{/if}
</div>
