<!--
	The recorder's two views (decision 76), each over its own files: "On
	this device", always there (decision 10), and "Synced", the repository,
	under the signed-in boundary (`SignedIn`), which also runs the uploader
	that moves this device's recordings into it. They are not merged; a
	recording that uploads leaves the one and appears in the other.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onMount } from 'svelte';
	import DeviceView from './DeviceView.svelte';
	import SignedIn from './SignedIn.svelte';
	import SyncedView from './SyncedView.svelte';
	import { auth } from './lib/auth.ts';

	// Leaving while a save is out asks first.
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

	<section aria-labelledby="device-heading">
		<h2 id="device-heading">On this device</h2>
		<DeviceView />
	</section>

	<section aria-labelledby="synced-heading">
		<h2 id="synced-heading">Synced</h2>
		{#if auth.state.status === 'signed-out'}
			<p class="meta">
				Sign in to see the recordings in your Epicenter repository. The ones
				on this device upload then.
			</p>
		{:else}
			{#key auth.state.account}
				<SignedIn account={auth.state.account}><SyncedView /></SignedIn>
			{/key}
		{/if}
	</section>
</main>
