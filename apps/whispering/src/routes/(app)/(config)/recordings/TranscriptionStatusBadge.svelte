<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import type { RecordingId } from '$lib/data';
	import { latestTranscription } from '$lib/whispering/transcriptions';

	// The recordings list is the durable failure log (ADR-0039): a failed
	// transcription shows a clear badge plus the full error inline, the detail
	// surface the failed pill, the OS notification, and Retry all point at. Only
	// terminal outcomes are stored, so an in-flight transcription has no badge
	// here (the row's action button shows that liveness).
	let {
		recordingId,
		store,
	}: {
		recordingId: RecordingId;
		store: import('$lib/whispering/app.js').RecordingStore;
	} = $props();

	const result = $derived(latestTranscription(store, recordingId));
</script>

{#if result}
	<Badge variant="status.completed">Transcribed</Badge>
{/if}
