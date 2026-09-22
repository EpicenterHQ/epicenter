<script lang="ts">
	import type { Recording } from '$lib/data';
	import SaveToPersonal from '$lib/components/SaveToPersonal.svelte';
	import { local } from '$lib/whispering/local.js';
	import Recordings from './Recordings.svelte';
</script>

<Recordings
	{actions}
	store={local}
	title="Local recordings"
	description="Recordings saved on this device."
	emptyDescription="Record or import audio to add a Local recording."
/>

{#snippet actions(recording: Recording)}<SaveToPersonal
		recordingId={recording.id}
	/>{/snippet}
