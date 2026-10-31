<!--
	Signed in: the person's `capture` repository beside this browser's files,
	as one list, and the uploader that moves the captures made here into the
	repository (decision 12).
-->
<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { capture } from '@epicenter/capture';
	import { outboxOf } from '@epicenter/folder/browser';
	import { openRemote, startUploading } from '@epicenter/folder/remote';
	import { fromClient } from '@epicenter/svelte/client';
	import { onDestroy } from 'svelte';
	import { createCaptureList } from '$lib/captures.svelte.js';
	import { getDevice } from '$lib/context.js';
	import CaptureApp from './CaptureApp.svelte';

	// One account for this component's life: the parent's `{#key}` makes a
	// new one for a new account, and sign-out or replacement retires this
	// remote and its uploader.
	const { account }: { account: Account } = $props();

	const device = getDevice();
	// svelte-ignore state_referenced_locally
	const remote = openRemote(capture, { account });
	const list = createCaptureList({
		device: device.files.captures,
		repository: fromClient(remote).captures,
		outbox: outboxOf(device.client),
	});
	// The uploader's writes reach both sides' listeners, so the list follows it.
	const uploader = startUploading(device.client, remote);
	onDestroy(() => uploader[Symbol.dispose]());
</script>

<CaptureApp {list} signedIn />
