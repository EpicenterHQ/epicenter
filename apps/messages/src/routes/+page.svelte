<!--
	Messages' replies are Markdown notes in the Messages folder on this
	computer, which its local program reads and writes; `Startup` asks
	whether that program serves this page before the app renders, under the
	layout's boundary. Messages never signs in, so nothing uploads.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onMount } from 'svelte';
	import { Startup } from '#platform/root';

	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);
</script>

<Startup />
