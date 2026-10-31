<!--
	Every page of Todos: the chrome and the leave guard. The app is the
	`(app)` group, whose layout decides the store; the sign-in callback is
	outside it.
-->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { isTauri } from '@tauri-apps/api/core';
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { base } from '$app/paths';
	import '@epicenter/ui/app.css';

	let props = $props();

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

<Tooltip.Provider>{@render props.children?.()}</Tooltip.Provider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
