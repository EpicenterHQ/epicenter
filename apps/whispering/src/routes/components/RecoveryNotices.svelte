<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Spinner } from '@epicenter/ui/spinner';
	import { rowPath } from '@epicenter/folder';
	import { TRANSFORMATIONS } from '$lib/definition.js';
	import type { Library, PendingRecording, TransformationRun } from '$lib/library.svelte.js';
	import AudioPlayer from './AudioPlayer.svelte';
	import { copyText, recordingTitle } from './file-actions.js';

	/**
	 * Everything held only in this window that needs the person: captured audio
	 * that is not in the folder, a transcript or transformation result whose file
	 * was not written, and requests still running or failed. It sits under the
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
	 * are held, from every page, so nothing that quitting would lose is hidden.
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
		library.pending.length > 0 || unsavedTranscripts.length > 0 || runs.length > 0 || heldText.length > 0,
	);

	function pendingHeadline(item: PendingRecording) {
		const { state } = item;
		switch (state.kind) {
			case 'saving':
				return 'Saving the recording…';
			case 'audioNotSaved':
				return state.certainty === 'unknown'
					? 'Not confirmed. The folder did not answer whether the audio was written.'
					: 'Not saved. The audio could not be written, so nothing of this recording was saved.';
			case 'rowNotSaved':
				return state.certainty === 'unknown'
					? 'The audio file is saved. The folder did not answer whether the recording’s file was written.'
					: 'The audio file is saved, but the recording’s file is not.';
			case 'refused':
				return 'Not saved. Nothing was written, because the folder is not as this recording expects.';
			case 'unchecked':
				return 'Not saved. The folder could not be checked, so nothing was written.';
			default:
				return state satisfies never;
		}
	}

	function discardPending(item: PendingRecording) {
		confirmationDialog.open({
			title: 'Discard this recording?',
			description:
				item.state.kind === 'rowNotSaved' && item.state.certainty === 'failed'
					? `The audio held in this window is dropped. ${item.state.audio.file.path} stays in the folder without a recording file.`
					: `The copy of the audio held in this window is dropped. Files already written to the folder stay there. This recording’s save is not resolved, so check the folder for ${item.capture.fields.audioPath} and recordings/${item.capture.id}.md to see what it holds.`,
			confirm: { text: 'Discard', variant: 'destructive' },
			onConfirm: () => library.discardPending(item.capture.id),
		});
	}

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
			{#each library.pending as item (item.capture.id)}
				<li class="flex flex-col gap-2 px-3 py-3 sm:px-4" data-testid="pending-recording" data-pending-state={item.state.kind}>
					<div class="flex items-center gap-2">
						{#if item.state.kind === 'saving'}<Spinner class="size-3.5" />{/if}
						<span class="font-medium">{pendingHeadline(item)}</span>
					</div>
					{#if item.state.kind !== 'saving'}
						<p class="text-xs text-muted-foreground" role="alert">{item.state.message}</p>
						<p class="text-xs text-muted-foreground">
							{#if item.state.kind === 'rowNotSaved'}
								The audio is in the folder as <code class="font-mono">{item.state.audio.file.path}</code>.
							{/if}
							The audio is kept in this window as <code class="font-mono">{item.capture.id}</code>
							({item.capture.bytes.byteLength.toLocaleString()} bytes, attempt {item.attempts}). Trying again reads what the
							folder has, finishes only what is missing, keeps this ID, and never creates a second recording.
						</p>
						<AudioPlayer source={{ kind: 'bytes', bytes: item.capture.bytes, mimeType: item.mimeType }} label="Recording that is not saved yet" />
						<div class="flex items-center gap-2">
							<Button size="sm" onclick={() => void library.retryPending(item.capture.id)} data-testid="retry-pending">Try again</Button>
							<Button size="sm" variant="ghost-destructive" onclick={() => discardPending(item)}>Discard</Button>
						</div>
					{/if}
				</li>
			{/each}

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
