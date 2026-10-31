<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { base } from '$app/paths';
	import { isDesktop } from '$lib/device.js';
	import '@epicenter/ui/app.css';

	let props = $props();

	// The browser build opens offline through its service worker
	// (`src/service-worker.js`). The desktop window loads the same build from
	// disk, where one has no use and may not register, so it never does.
	onMount(() => {
		if (isDesktop || !('serviceWorker' in navigator)) return;
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
