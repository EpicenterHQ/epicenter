<!--
	Messages' drafts and send attempts are this browser's files for this
	origin (OPFS), which `Startup` opens before the app renders, under the
	layout's boundary. Messages never signs in, so nothing uploads.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onMount } from 'svelte';
	import Startup from '$lib/Startup.svelte';

	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);
</script>

<Startup />
