<!--
	The root: this browser's files, always there (decision 10), and the one
	list over them. Signed in, the signed-in subtree adds the person's
	`capture` repository and the uploader, one per account.
-->
<script lang="ts">
	import { capture } from '@epicenter/capture';
	import { closeDevice, openDevice, outboxOf } from '@epicenter/folder/browser';
	import { fromClient } from '@epicenter/svelte/client';
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onDestroy, onMount } from 'svelte';
	import CaptureApp from '$lib/components/CaptureApp.svelte';
	import SignedIn from '$lib/components/SignedIn.svelte';
	import { webAuth } from '$lib/auth.js';
	import { createCaptureList } from '$lib/captures.svelte.js';
	import { setDevice } from '$lib/context.js';

	const auth = webAuth();
	const client = openDevice(capture);
	const device = setDevice({ client, files: fromClient(client) });
	onDestroy(() => closeDevice(client));
	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);

	const list = createCaptureList({
		device: device.files.captures,
		repository: null,
		outbox: outboxOf(client),
	});
</script>

{#if auth.state.status === 'signed-out'}
	<CaptureApp {list} signedIn={false} />
{:else}
	{#key auth.state.account}
		<SignedIn account={auth.state.account} />
	{/key}
{/if}
