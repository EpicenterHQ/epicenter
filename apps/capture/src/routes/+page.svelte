<!--
	The root: Capture over this browser's files, always there (decision 10).
	Signed in, the signed-in boundary adds the person's `capture` repository
	and the uploader, one per account.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { onMount } from 'svelte';
	import CaptureApp from '$lib/components/CaptureApp.svelte';
	import SignedIn from '$lib/components/SignedIn.svelte';
	import { webAuth } from '$lib/auth.js';

	const auth = webAuth();
	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);
</script>

{#if auth.state.status === 'signed-out'}
	<CaptureApp signedIn={false} />
{:else}
	{#key auth.state.account}
		<SignedIn account={auth.state.account}><CaptureApp signedIn /></SignedIn>
	{/key}
{/if}
