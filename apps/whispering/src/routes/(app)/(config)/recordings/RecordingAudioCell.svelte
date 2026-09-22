<script lang="ts">
	import type { Recording } from '../../../../lib/data.js';
	import AudioBlobPlayer from '$lib/components/AudioBlobPlayer.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	let {
		recording,
		store,
	}: {
		recording: Recording;
		store: import('$lib/whispering/app.js').RecordingStore;
	} = $props();
</script>

<AudioBlobPlayer
	{store}
	id={recording.id}
	class="h-8"
	viewTransitionName={viewTransition.recording(recording.id).audio}
/>
