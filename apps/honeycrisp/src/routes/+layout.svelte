<!--
	Every page of Honeycrisp. Signed in, the signed-in boundary (`SignedIn`)
	wraps every page: the person's repository for the "Synced" page, and the
	uploader that moves this device's notes and folders into it while any
	page is open (decision 76).
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { webAuth } from '$lib/auth.js';
	import SignedIn from '$lib/components/SignedIn.svelte';
	import '@epicenter/ui/app.css';

	let props = $props();
	const auth = webAuth();

	// Leaving while a save is out asks first.
	onMount(guardLeave);
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

<Tooltip.Provider>
	{#if auth.state.status === 'signed-out'}
		{@render props.children?.()}
	{:else}
		{#key auth.state.account}
			<SignedIn account={auth.state.account}>{@render props.children?.()}</SignedIn>
		{/key}
	{/if}
</Tooltip.Provider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
