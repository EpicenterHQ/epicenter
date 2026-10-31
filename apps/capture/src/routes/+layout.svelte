<!--
	Every page of Capture: the chrome only. The views and their signed-in
	boundary are the `(app)` group's; the sign-in callback is outside it.
-->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { openOffline } from '#platform/offline';
	import { onMount } from 'svelte';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	// A browser opens offline through its service worker; the desktop
	// window's build has nothing to do (`#platform/offline`).
	onMount(openOffline);
</script>

<svelte:head><title>Capture</title></svelte:head>
<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
<Toaster closeButton />
<ConfirmationDialog />
