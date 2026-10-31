<!--
	Vocab's two views (decision 76), "On this device" (`/`) and "Synced"
	(`/synced`). Signed in, the signed-in boundary (`SignedIn`) wraps both: the
	learner's repository for "Synced", and the uploader that moves this
	browser's words and chats into it while either is open. The sign-in
	callback is outside this group, under the chrome-only root, so it opens
	nothing (ADR-0345).
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onMount } from 'svelte';
	import { auth } from '$lib/auth.svelte.js';
	import SignedIn from '../components/SignedIn.svelte';

	let { children } = $props();

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
