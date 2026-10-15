<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Spinner } from '@epicenter/ui/spinner';
	import { rowPath } from '@epicenter/folder';
	import { TRANSFORMATIONS } from '$lib/definition.js';
	import type { Library, TransformationRun } from '$lib/library.svelte.js';
	import { copyText, recordingTitle } from './file-actions.js';

	/**
	 * Everything held only in this window that needs the person: a transcript or
	 * transformation result whose file was not written, and requests still
	 * running or failed. A recording is never here: it is in the folder from
	 * the moment it starts. It sits under the
	 * header on every page, so recovery never depends on which page is open and
	 * no list filter can hide it.
	 */
	let { library, onOpenRecording, onOpenTransformation }: {
		library: Library;
		onOpenRecording: (path: string) => void;
		onOpenTransformation: (path: string) => void;
	} = $props();

	/**
	 * Results on pasted text that arrived and are held here. They are saved,
	 * copied, or discarded on their transformation's page; this only says they
	 * are held, from every page, so nothing that keeps the app open is hidden.
	 */
	const heldText = $derived(library.textRuns.filter((run) => run.state.kind === 'unsaved'));

	const unsavedTranscripts = $derived(
		library.unsavedTranscripts.map((id) => ({
			id,
			entry: library.entries.find((entry) => entry.stem === id),
		})),
	);
	const runs = $derived(library.transformationRuns);
	const any = $derived(
		unsavedTranscripts.length > 0 || runs.length > 0 || heldText.length > 0,
	);

	function discardTranscript(id: string) {
		confirmationDialog.open({
			title: 'Discard this transcript?',
			description:
				'The text held in this window is dropped. A file an earlier save already wrote stays in the folder. Transcribing again sends the audio to the endpoint again.',
			confirm: { text: 'Discard', variant: 'destructive' },
			onConfirm: () => library.dismissRun(id),
		});
	}

	function discardRun(run: TransformationRun) {
		if (run.state.kind !== 'unsaved') {
			library.discardTransformationRun(run.id);
			return;
		}
		confirmationDialog.open({
			title: 'Discard this result?',
			description: 'The text held in this window is dropped. Running the transformation again calls the endpoint again.',
			confirm: { text: 'Discard', variant: 'destructive' },
			onConfirm: () => library.discardTransformationRun(run.id),
		});
	}
</script>

{#if any}
	<section class="max-h-64 shrink-0 overflow-y-auto border-b bg-destructive/5 text-sm" aria-label="Needs your attention" data-testid="recovery">
		<ul class="divide-y">
			{#each unsavedTranscripts as { id, entry } (id)}
				{@const run = library.transcriptionRun(id)}
				{#if run?.kind === 'unsaved'}
					<li class="flex flex-col gap-2 px-3 py-3 sm:px-4" data-testid="unsaved-transcript">
						<p class="font-medium">
							The transcript of {entry ? `“${recordingTitle(entry)}”` : id} arrived, but its file is not confirmed as saved.
						</p>
						<p class="text-xs text-muted-foreground" role="alert">{run.message}</p>
						<p class="max-h-24 overflow-y-auto rounded border bg-background p-2 whitespace-pre-wrap">{run.text}</p>
						<p class="text-xs text-muted-foreground">
							Saving again writes <code class="font-mono">transcriptions/{run.id}.md</code>, or finds it there from an earlier
							attempt, and does not call the endpoint again.
						</p>
						<div class="flex items-center gap-2">
							<Button size="sm" disabled={run.saving} onclick={() => void library.retrySaveResult(id)} data-testid="retry-transcript">
								{#if run.saving}<Spinner class="size-3.5" />{/if}
								Save it again
							</Button>
							<Button size="sm" variant="outline" onclick={() => void copyText(run.text, 'the transcript')}>Copy</Button>
							{#if entry}
								<Button size="sm" variant="ghost" onclick={() => onOpenRecording(entry.path)}>Open the recording</Button>
							{/if}
							<Button size="sm" variant="ghost-destructive" onclick={() => discardTranscript(id)} data-testid="discard-transcript">Discard</Button>
						</div>
					</li>
				{/if}
			{/each}

			{#each runs as run (run.id)}
				<li class="flex flex-col gap-2 px-3 py-3 sm:px-4" data-testid="transformation-run" data-run-state={run.state.kind}>
					{#if run.state.kind === 'running'}
						<p class="flex items-center gap-2 font-medium">
							<Spinner class="size-3.5" /> Running “{run.fields.transformationTitle}”…
						</p>
					{:else if run.state.kind === 'failed'}
						<p class="font-medium">“{run.fields.transformationTitle}” did not run. The transcript is unchanged.</p>
						<p class="text-xs text-muted-foreground" role="alert" data-testid="transformation-error">{run.state.message}</p>
						<div class="flex items-center gap-2">
							<Button size="sm" onclick={() => void library.retryTransformation(run.id)} data-testid="retry-transformation">Try again</Button>
							<Button size="sm" variant="ghost" onclick={() => discardRun(run)}>Dismiss</Button>
						</div>
					{:else}
						{@const text = run.state.text}
						<p class="font-medium">The result of “{run.fields.transformationTitle}” arrived, but its file was not saved.</p>
						<p class="text-xs text-muted-foreground" role="alert">{run.state.message}</p>
						<p class="max-h-24 overflow-y-auto rounded border bg-background p-2 whitespace-pre-wrap">{text}</p>
						<p class="text-xs text-muted-foreground">
							Saving again writes <code class="font-mono">transformation_runs/{run.id}.md</code> and does not call the endpoint again.
						</p>
						<div class="flex items-center gap-2">
							<Button size="sm" onclick={() => void library.retryTransformation(run.id)} data-testid="retry-transformation-save">Save it again</Button>
							<Button size="sm" variant="outline" onclick={() => void copyText(text, 'the result')}>Copy</Button>
							<Button size="sm" variant="ghost-destructive" onclick={() => discardRun(run)}>Discard</Button>
						</div>
					{/if}
				</li>
			{/each}

			{#each heldText as run (run.id)}
				<li class="flex flex-wrap items-center gap-2 px-3 py-3 sm:px-4" data-testid="held-text-run">
					<p class="min-w-0 flex-1">
						A result of “{run.fields.transformationTitle}” on pasted text is held in this window and not saved.
					</p>
					<Button
						size="sm"
						variant="outline"
						onclick={() => onOpenTransformation(rowPath(TRANSFORMATIONS, run.fields.transformationId))}
					>
						Open to save or discard
					</Button>
				</li>
			{/each}
		</ul>
	</section>
{/if}
