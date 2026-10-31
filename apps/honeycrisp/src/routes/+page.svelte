<!--
	The root: Honeycrisp over this browser's files (OPFS), always there
	(decision 10). Signed in, the signed-in boundary adds the person's
	repository, one per account.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onMount } from 'svelte';
	import { webAuth } from '$lib/auth.js';
	import HoneycrispApp from '$lib/components/HoneycrispApp.svelte';
	import SignedIn from '$lib/components/SignedIn.svelte';

	const auth = webAuth();
	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);
</script>

{#if auth.state.status === 'signed-out'}
	<HoneycrispApp signedIn={false} />
{:else}
	{#key auth.state.account}
		<SignedIn account={auth.state.account}><HoneycrispApp signedIn /></SignedIn>
	{/key}
{/if}
