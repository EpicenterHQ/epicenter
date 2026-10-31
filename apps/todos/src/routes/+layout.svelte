<!--
	Every page of Todos. In a browser, signed in, the signed-in boundary
	(`SignedIn`) wraps every page: the person's repository for the "Synced"
	page, and the uploader that moves this device's todos into it while any
	page is open (decision 76). The desktop window never signs in: Epicenter
	syncs its folder.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { isTauri } from '@tauri-apps/api/core';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { base } from '$app/paths';
	import SignedIn from '$lib/components/SignedIn.svelte';
	import { webAuth } from '$lib/auth.js';
	import '@epicenter/ui/app.css';

	let props = $props();
	const auth = webAuth();

	// Leaving while a save is out asks first; a desktop window waits for it.
	onMount(guardLeave);

	// The browser build opens offline through its service worker
	// (`src/service-worker.js`). The desktop window loads the same build from
	// disk, where one has no use and may not register, so it never does.
	onMount(() => {
		if (isTauri() || !('serviceWorker' in navigator)) return;
		// Offline opening is best effort: the page works without it.
		navigator.serviceWorker
			.register(`${base}/service-worker.js`, { type: dev ? 'module' : 'classic' })
			.catch(() => {});
	});
</script>

<svelte:head><title>Todos</title></svelte:head>

<Tooltip.Provider>
	{#if auth === null || auth.state.status === 'signed-out'}
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
