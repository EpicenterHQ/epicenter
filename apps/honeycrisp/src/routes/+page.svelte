<!--
	The root: this browser's files (OPFS), always there (decision 10), and
	the notes and folders over them. Signed in, the signed-in subtree adds
	the person's repository, one per account.
-->
<script lang="ts">
	import { closeDevice, openDevice, outboxOf } from '@epicenter/folder/browser';
	import { fromClient } from '@epicenter/svelte/client';
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onDestroy, onMount } from 'svelte';
	import { webAuth } from '$lib/auth.js';
	import HoneycrispApp from '$lib/components/HoneycrispApp.svelte';
	import SignedIn from '$lib/components/SignedIn.svelte';
	import { honeycrisp } from '$lib/contract.js';
	import { createLists, setDevice } from '$lib/honeycrisp.svelte.js';

	const auth = webAuth();
	const client = openDevice(honeycrisp);
	const device = setDevice({ client, files: fromClient(client) });
	onDestroy(() => closeDevice(client));
	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);

	const lists = createLists({ device: device.files, repository: null, outbox: outboxOf(client) });
</script>

{#if auth.state.status === 'signed-out'}
	<HoneycrispApp {lists} />
{:else}
	{#key auth.state.account}
		<SignedIn account={auth.state.account} />
	{/key}
{/if}
