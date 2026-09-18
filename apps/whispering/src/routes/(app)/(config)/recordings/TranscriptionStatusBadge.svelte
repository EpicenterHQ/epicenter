<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import type { RecordingId } from '$lib/data';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();

	// The recordings list is the durable failure log (ADR-0039): a failed
	// transcription shows a clear badge plus the full error inline, the detail
	// surface the failed pill, the OS notification, and Retry all point at. Only
	// terminal outcomes are stored, so an in-flight transcription has no badge
	// here (the row's action button shows that liveness).
	let { recordingId }: { recordingId: RecordingId } = $props();

	const recording = $derived(app.recordings.get(recordingId));
</script>

{#if recording?.transcriptionStatus === 'failed'}
	<div class="flex max-w-[280px] items-center gap-2">
		<Badge variant="status.failed">Failed</Badge>
		<span
			class="truncate text-muted-foreground text-xs"
			title={recording.transcriptionError ?? undefined}
		>
			{recording.transcriptionError}
		</span>
	</div>
{:else if recording?.transcriptionStatus === 'completed'}
	<Badge variant="status.completed">Transcribed</Badge>
{/if}
