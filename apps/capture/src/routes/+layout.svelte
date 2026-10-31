<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { base } from '$app/paths';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	// The page opens offline through its service worker
	// (`src/service-worker.js`): a module in dev, a classic script in a build.
	onMount(() => {
		if (!('serviceWorker' in navigator)) return;
		// Offline opening is best effort: the page works without it.
		navigator.serviceWorker
			.register(`${base}/service-worker.js`, { type: dev ? 'module' : 'classic' })
			.catch(() => {});
	});
</script>

<svelte:head><title>Capture</title></svelte:head>
<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
<Toaster closeButton />
<ConfirmationDialog />
