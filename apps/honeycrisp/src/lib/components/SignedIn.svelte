<!--
	Signed in: the person's `honeycrisp` repository beside this browser's
	files, as one list per collection, and the uploader that moves the notes
	and folders made here signed out or offline into the repository
	(decision 12).
-->
<script lang="ts">
	import type { Account } from '@epicenter/auth';
	import { outboxOf } from '@epicenter/folder/browser';
	import { openRemote, startUploading } from '@epicenter/folder/remote';
	import { fromClient } from '@epicenter/svelte/client';
	import { onDestroy } from 'svelte';
	import { honeycrisp } from '$lib/contract.js';
	import { createLists, getDevice } from '$lib/honeycrisp.svelte.js';
	import HoneycrispApp from './HoneycrispApp.svelte';

	// One account for this component's life: the parent's `{#key}` makes a
	// new one for a new account, and sign-out or replacement retires this
	// remote and its uploader.
	const { account }: { account: Account } = $props();

	const device = getDevice();
	// svelte-ignore state_referenced_locally
	const remote = openRemote(honeycrisp, { account });
	const lists = createLists({
		device: device.files,
		repository: fromClient(remote),
		outbox: outboxOf(device.client),
	});
	// The uploader's writes reach both sides' listeners, so the lists follow it.
	const uploader = startUploading(device.client, remote);
	onDestroy(() => uploader[Symbol.dispose]());
</script>

<HoneycrispApp {lists} />
