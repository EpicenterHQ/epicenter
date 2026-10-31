<!--
	Capture's two views (decision 76), "On this device" (`/`) and "Synced"
	(`/synced`). Signed in, the signed-in boundary (`SignedIn`) wraps both:
	the person's repository for "Synced", and the uploader that moves this
	browser's captures into it while either is open. The sign-in callback is
	outside this group, so it opens neither.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onMount } from 'svelte';
	import SignedIn from '$lib/components/SignedIn.svelte';
	import { webAuth } from '$lib/auth.js';

	let { children } = $props();
	const auth = webAuth();

	// Leaving while a save is out asks first.
	onMount(guardLeave);
</script>

{#if auth.state.status === 'signed-out'}
	{@render children()}
{:else}
	{#key auth.state.account}
		<SignedIn account={auth.state.account}>{@render children()}</SignedIn>
	{/key}
{/if}
