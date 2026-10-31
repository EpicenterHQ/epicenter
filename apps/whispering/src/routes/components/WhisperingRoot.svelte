<!--
	The root: the app over this browser's files (`$lib/device.ts`), always
	there (decision 10). Signed in, the signed-in boundary adds the person's
	repository, one per account; signing out or another person signing in
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
	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);
</script>

{#if auth.state.status === 'signed-out'}
	<WhisperingApp signedIn={false}>{@render children()}</WhisperingApp>
{:else}
	{#key auth.state.account}
		<SignedIn account={auth.state.account}>
			<WhisperingApp signedIn>{@render children()}</WhisperingApp>
		</SignedIn>
	{/key}
{/if}
