<!--
	Todos' two views (decision 76), "On this device" (`/`) and "Synced"
	(`/synced`). In a browser, signed in, the signed-in boundary (`SignedIn`)
	wraps both: the person's repository for "Synced", and the uploader that
	moves this device's todos into it while either is open. The sign-in
	callback is outside this group, so it opens neither. The desktop window
	never signs in: Epicenter syncs its folder.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onMount } from 'svelte';
	import SignedIn from '$lib/components/SignedIn.svelte';
	import { webAuth } from '$lib/auth.js';

	let { children } = $props();
	const auth = webAuth();

	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);
</script>

{#if auth === null || auth.state.status === 'signed-out'}
	{@render children()}
{:else}
	{#key auth.state.account}
		<SignedIn account={auth.state.account}>{@render children()}</SignedIn>
	{/key}
{/if}
