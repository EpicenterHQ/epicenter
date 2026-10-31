<!--
	Messages' drafts and send attempts are this browser's files for this
	origin (OPFS, `$lib/device.ts`). Messages never signs in, so nothing
	uploads.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onMount } from 'svelte';
	import MessagesApp from '$lib/MessagesApp.svelte';

	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);
</script>

<MessagesApp />
