<script lang="ts">
	import type { Recording } from '$lib/state/recordings.svelte';
	import TranscribeRecordingButton from './TranscribeRecordingButton.svelte';

	/**
	 * The compact per-row actions: only the things worth firing without opening
	 * anything. Transcribe is the hot path.
	 *
	 * Everything else has a better home and was duplicating it here: copy lives
	 * in the transcript cell already, and download, run history, and delete live
	 * in the recording detail modal (open it by clicking the transcript). Keeping
	 * the row lean stops it from re-offering what its neighboring columns and the
	 * modal already do.
	 */
	let { recording }: { recording: Recording } = $props();
</script>

<div class="flex items-center gap-1">
	<TranscribeRecordingButton {recording} />
</div>
