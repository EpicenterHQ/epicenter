<script lang="ts">
	import { getPersonal } from '$lib/whispering/personal.js';
	import Recordings from '../recordings/Recordings.svelte';
	const personal = getPersonal();
</script>

<Recordings
	store={personal}
	title="Personal recordings"
	description="Independent recordings saved to your account."
	emptyDescription="Use Save to Personal on a Local recording to add one."
/>
