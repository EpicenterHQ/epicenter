<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import * as InputGroup from '@epicenter/ui/input-group';
	import type { RecordingId } from '$lib/workspace';
	import { createCopyFn } from '$lib/utils/createCopyFn';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import { fromSubscription } from '@epicenter/svelte';
	import { getWhisperingApp, getRecordingEditor } from '$lib/whispering/context';

	const app = getWhisperingApp();
	const editor = getRecordingEditor();
	const editorState = fromSubscription(editor.subscribe, () => editor.state);

	/**
	 * The transcript column cell. Shows the transcript inline (or an "Empty
	 * transcript" placeholder for not-yet-transcribed rows) and opens the
	 * recording detail modal when clicked, so every row is reachable from the
	 * most natural gesture. The inline copy button keeps the fast-copy path
	 * without opening anything.
	 */
	let { recordingId }: { recordingId: RecordingId } = $props();

	let showOriginal = $state(false);
	const recording = $derived(app.recordings.get(recordingId));
	const hasDeliveredTranscript = $derived(!!recording?.polishedTranscript);
	const transcript = $derived(
		showOriginal
			? (recording?.transcript ?? '')
			: (recording?.polishedTranscript ?? recording?.transcript ?? ''),
	);
	const hasTranscript = $derived(!!transcript.trim());
</script>

{#if recording}
	<InputGroup.Root>
		<button
			type="button"
			data-slot="input-group-control"
			class="flex-1 min-w-0 rounded-none border-0 bg-transparent py-2 px-3 text-left text-sm leading-snug hover:bg-accent/50 transition-colors"
			style:view-transition-name={viewTransition.recording(recordingId).transcript}
			onclick={() => editor.open(recordingId)}
			aria-haspopup="dialog"
			aria-label="Open {recording.title || 'untitled recording'}"
		>
			<span class="line-clamp-2">{transcript || 'Empty transcript, click to open'}</span>
			{#if editorState.current.drafts.some((draft) => draft.id === recordingId)}
				<span class="text-muted-foreground text-xs">Unsaved draft</span>
			{/if}
		</button>
		{#if hasTranscript}
			{#if hasDeliveredTranscript}
				<InputGroup.Addon align="inline-end">
					<Button
						variant="ghost"
						size="sm"
						tooltip={showOriginal
							? 'Show delivered transcript'
							: 'Show original transcript'}
						onclick={(e) => {
							e.stopPropagation();
							showOriginal = !showOriginal;
						}}
					>
						{showOriginal ? 'Result' : 'Original'}
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
