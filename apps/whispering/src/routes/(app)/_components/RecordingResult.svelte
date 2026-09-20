<script lang="ts">
	import { resolve } from '$app/paths';
	import { Link } from '@epicenter/ui/link';
	import { Button } from '@epicenter/ui/button';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import AudioBlobPlayer from '$lib/components/AudioBlobPlayer.svelte';
	import TextPreviewDialog from '$lib/components/copyable/TextPreviewDialog.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import type { RecordingId } from '$lib/data';

	let {
		recordingId,
		transcript,
		rows = 1,
		onDelete,
	}: {
		recordingId: RecordingId;
		transcript: string;
		/** Visible rows of the transcript preview before it scrolls/expands. */
		rows?: number;
		/** When provided, a delete button is shown at the end of the audio row. */
		onDelete?: () => void;
	} = $props();

</script>

<div class="flex w-full flex-col gap-2">
	{#if transcript.trim()}
	<TextPreviewDialog
		id={viewTransition.recording(recordingId).transcript}
		title="Transcript"
		label="transcript"
		text={transcript}
		{rows}
	/>
	{:else}
		<p class="text-sm text-muted-foreground">Audio saved. <Link href={resolve('/recordings')}>Transcribe from Recordings</Link>.</p>
	{/if}
	<!-- Delete is a companion action on the audio row, mirroring the copy button
	     on the transcript row above: content stretches, its action caps the row.
	     Icon-only with a tooltip; the confirmation dialog carries the words. -->
	{#if recordingId}
		<div class="flex w-full items-center gap-2">
			<AudioBlobPlayer
				id={recordingId}
				class="h-8 min-w-0 flex-1"
				viewTransitionName={viewTransition.recording(recordingId).audio}
			/>
			{#if onDelete}
				<Button
					class="ml-auto"
					variant="ghost-destructive"
					size="icon-sm"
					tooltip="Delete recording"
					aria-label="Delete recording"
					onclick={onDelete}
				>
					<TrashIcon class="size-4" />
				</Button>
			{/if}
		</div>
	{/if}
</div>
