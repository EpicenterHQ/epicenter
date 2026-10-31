<!--
	The root of every page but the sign-in callback. Signed out, Whispering
	runs over this browser's files alone. Signed in, the signed-in boundary
	(`SignedIn`) wraps every page: the person's repository for the "Synced"
	pages, and the uploader that moves this browser's files into it while any
	page is open (decision 76). Signing out or another person signing in
	makes a new one, so one person's credential never reads another's files.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onMount, type Snippet } from 'svelte';
	import { getAuth } from '#platform/auth';
	import SignedIn from './SignedIn.svelte';
	import WhisperingApp from './WhisperingApp.svelte';

	let { children }: { children: Snippet } = $props();

	const auth = getAuth();
	// Leaving while a save is out asks first.
	onMount(guardLeave);
</script>

{#if auth.state.status === 'signed-out'}
	<WhisperingApp>{@render children()}</WhisperingApp>
{:else}
	{#key auth.state.account}
		<SignedIn account={auth.state.account}>
			<WhisperingApp>{@render children()}</WhisperingApp>
		</SignedIn>
	{/key}
{/if}
