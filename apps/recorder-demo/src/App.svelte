<script lang="ts">
	import { closeDevice, openDevice } from '@epicenter/folder/browser';
	import { onDestroy } from 'svelte';
	import Library from './Library.svelte';
	import SignedIn from './SignedIn.svelte';
	import { recorder } from './contract.ts';
	import { auth } from './lib/auth.ts';
	import { setDevice } from './lib/context.ts';

	// The device is there whether or not anyone is signed in (decision 10).
	const device = setDevice(openDevice(recorder));
	onDestroy(() => closeDevice(device));
</script>

<main>
	<header>
		<h1>Recorder</h1>
		{#if auth.state.status === 'signed-out'}
			<button onclick={() => auth.startSignIn()}>Sign in</button>
		{:else}
			{#if auth.state.status === 'reauth-required'}
				<span class="meta">Uploads are paused.</span>
				<button onclick={() => auth.startSignIn()}>Sign in again</button>
			{/if}
			<button onclick={() => auth.signOut()}>Sign out</button>
		{/if}
	</header>

	{#if auth.state.status !== 'signed-out'}
		{#key auth.state.account}
			<SignedIn account={auth.state.account} />
		{/key}
	{:else}
		<Library remote={null} />
	{/if}
</main>
