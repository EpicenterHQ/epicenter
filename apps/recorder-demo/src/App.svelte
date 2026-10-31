<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onMount } from 'svelte';
	import Library from './Library.svelte';
	import SignedIn from './SignedIn.svelte';
	import { auth } from './lib/auth.ts';

	// The device (`lib/device.ts`) is there whether or not anyone is signed
	// in (decision 10). Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);
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
			<SignedIn account={auth.state.account}><Library signedIn /></SignedIn>
		{/key}
	{:else}
		<Library signedIn={false} />
	{/if}
</main>
