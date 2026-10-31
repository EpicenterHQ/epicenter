<!--
	The root: this browser's files, always there (decision 10), and the app
	over them. Signed in, the signed-in subtree adds the person's repository,
	one per account; signing out or another person signing in makes a new
	one, so one person's credential never reads another's files.
-->
<script lang="ts">
	import { closeDevice } from '@epicenter/folder/browser';
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onDestroy, onMount, type Snippet } from 'svelte';
	import { getAuth } from '#platform/auth';
	import { openWhisperingDevice } from '$lib/device.js';
	import SignedIn from './SignedIn.svelte';
	import WhisperingApp from './WhisperingApp.svelte';

	let { children }: { children: Snippet } = $props();

	const auth = getAuth();
	const device = openWhisperingDevice();
	onDestroy(() => closeDevice(device));
	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);
</script>

{#if auth.state.status === 'signed-out'}
	<WhisperingApp {device} repository={null}>{@render children()}</WhisperingApp>
{:else}
	{#key auth.state.account}
		<SignedIn {device} account={auth.state.account}>{@render children()}</SignedIn>
	{/key}
{/if}
