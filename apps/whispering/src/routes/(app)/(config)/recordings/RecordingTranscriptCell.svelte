<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import * as InputGroup from '@epicenter/ui/input-group';
	import type { RecordingId } from '$lib/data';
	import { createCopyFn } from '$lib/utils/createCopyFn';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import RecordingDetailModal from './RecordingDetailModal.svelte';
	import { getWhisperingApp } from '$lib/whispering/context';
	import { latestTranscription } from '$lib/whispering/transcriptions';

	const app = getWhisperingApp();

	/**
	 * The transcript column cell. Shows the transcript inline (or an "Empty
	 * transcript" placeholder for not-yet-transcribed rows) and opens the
	 * recording detail modal when clicked, so every row is reachable from the
	 * most natural gesture. The inline copy button keeps the fast-copy path
	 * without opening anything.
	 */
	let {
		recordingId,
		store,
	}: {
		recordingId: RecordingId;
		store: import('$lib/whispering/app.js').RecordingStore;
	} = $props();

	let showOriginal = $state(false);
	const recording = $derived(store.tables.recordings.get(recordingId));
	const result = $derived(latestTranscription(store, recordingId));
	const hasCleanedTranscript = $derived(!!result?.cleanedText);
	const transcript = $derived(
		showOriginal
			? (result?.rawText ?? '')
			: (result?.cleanedText ?? result?.rawText ?? ''),
	);
	const hasTranscript = $derived(!!transcript.trim());
</script>

{#if recording}
	<InputGroup.Root>
		<RecordingDetailModal {recording} {store}>
			{#snippet trigger(props)}
				<textarea
					{...props}
					data-slot="input-group-control"
					class="flex-1 min-w-0 resize-none rounded-none border-0 bg-transparent py-2 px-3 shadow-none focus-visible:ring-0 focus:outline-none dark:bg-transparent text-sm leading-snug hover:cursor-pointer hover:bg-accent/50 transition-colors min-h-0"
					readonly
					value={transcript}
					placeholder="Empty transcript, click to open"
					style:view-transition-name={viewTransition.recording(recordingId)
						.transcript}
					rows={1}
					aria-label="Click to open this recording"></textarea>
			{/snippet}
		</RecordingDetailModal>
		{#if hasTranscript}
			{#if hasCleanedTranscript}
				<InputGroup.Addon align="inline-end">
					<Button
						variant="ghost"
						size="sm"
						tooltip={showOriginal
							? 'Show cleaned transcript'
							: 'Show original transcript'}
						onclick={(e) => {
							e.stopPropagation();
							showOriginal = !showOriginal;
						}}
					>
						{showOriginal ? 'Cleaned' : 'Original'}
					</Button>
				</InputGroup.Addon>
			{/if}
			<InputGroup.Addon align="inline-end">
				<CopyButton
					text={transcript}
					copyFn={createCopyFn('transcript')}
					onclick={(e) => e.stopPropagation()}
				/>
			</InputGroup.Addon>
		{/if}
	</InputGroup.Root>
{/if}
