<!--
	Messages' drafts and send attempts are this browser's files for this
	origin (OPFS), opened at the root. Messages never signs in, so nothing
	uploads (see `$lib/context.ts`).
-->
<script lang="ts">
	import { closeDevice, openDevice } from '@epicenter/folder/browser';
	import { fromClient } from '@epicenter/svelte/client';
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onDestroy, onMount } from 'svelte';
	import { setDevice } from '$lib/context.js';
	import { messages } from '$lib/contract.js';
	import MessagesApp from '$lib/MessagesApp.svelte';

	const client = openDevice(messages);
	setDevice({ client, files: fromClient(client) });
	onDestroy(() => closeDevice(client));
	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);
</script>

<MessagesApp />
