<script lang="ts">
	import { local } from '$lib/whispering/local.js';
	import Recordings from './Recordings.svelte';
</script>

<Recordings
	store={local}
	title="Local recordings"
	description="Recordings saved on this device."
	emptyDescription="Record or import audio to add a Local recording."
/>
