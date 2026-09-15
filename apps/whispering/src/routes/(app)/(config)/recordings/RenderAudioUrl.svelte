<script lang="ts">
	import AudioBlobPlayer from '$lib/components/AudioBlobPlayer.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import type { RecordingId } from '$lib/data';

	let { id, audio }: { id: RecordingId; audio: string | null } = $props();
</script>

<AudioBlobPlayer
	{id}
	{audio}
	class="h-8"
	viewTransitionName={viewTransition.recording(id).audio}
/>
