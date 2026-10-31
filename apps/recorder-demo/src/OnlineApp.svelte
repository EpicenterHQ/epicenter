<!--
	The online variant (`/online`): signed in, the person's repository
	(`SignedIn`), recorded into and played from directly, with nothing kept
	in this browser (ADR-0700); signed out, a sign-in instead. It is online
	only: without the server it can neither list nor record.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onMount } from 'svelte';
	import Header from './Header.svelte';
	import SignedIn from './SignedIn.svelte';
	import { auth } from './lib/auth.ts';

	// Leaving while a save is out asks first.
	onMount(guardLeave);
</script>

<main>
	<Header variant="online">
		{#if auth.state.status !== 'signed-out'}
			{#if auth.state.status === 'reauth-required'}
				<button onclick={() => auth.startSignIn()}>Sign in again</button>
			{/if}
			<button onclick={() => auth.signOut()}>Sign out</button>
		{/if}
	</Header>
	<section aria-labelledby="online-heading">
		<h2 id="online-heading">Online</h2>
		{#if auth.state.status === 'signed-out'}
			<p class="meta">Sign in to record into your Epicenter repository.</p>
			<p><button onclick={() => auth.startSignIn()}>Sign in</button></p>
		{:else}
			{#if auth.state.status === 'reauth-required'}
				<p class="meta">Sign in again to use your repository.</p>
			{/if}
			{#key auth.state.account}
				<SignedIn account={auth.state.account} />
			{/key}
		{/if}
	</section>
</main>
