<!--
	The root: this browser's files (OPFS), always there with no sign-in in
	front of them (decision 10), and Vocab over them. Signed in, the
	signed-in subtree adds the learner's `vocab` repository, one per account,
	and uploads what was made here.
-->
<script lang="ts">
	import { closeDevice, openDevice, outboxOf } from '@epicenter/folder/browser';
	import { fromClient } from '@epicenter/svelte/client';
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onDestroy, onMount } from 'svelte';
	import { auth } from '$lib/auth.svelte.js';
	import { setDevice } from '$lib/context.js';
	import { vocab } from '$lib/contract.js';
	import { createVocabLists } from '$lib/vocab.svelte.js';
	import SignedIn from './components/SignedIn.svelte';
	import VocabApp from './components/VocabApp.svelte';

	const client = openDevice(vocab);
	const device = setDevice({ client, files: fromClient(client) });
	onDestroy(() => closeDevice(client));
	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);

	const lists = createVocabLists({
		device: device.files,
		repository: null,
		outbox: outboxOf(client),
	});
</script>

{#if auth.state.status === 'signed-out'}
	<VocabApp {lists} account={undefined} />
{:else}
	{#key auth.state.account}
		<SignedIn account={auth.state.account} />
	{/key}
{/if}
