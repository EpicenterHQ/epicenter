<!--
	Every page of Capture: the chrome. The app is the `(app)` group, whose
	layout renders the folder's pages and asks before a page with a write
	out is left; the sign-in callback is outside it.
-->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import '@epicenter/ui/app.css';

	let { children } = $props();
</script>

<svelte:head><title>Capture</title></svelte:head>
<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
<Toaster closeButton />
<ConfirmationDialog />
