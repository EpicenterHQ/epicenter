<!--
	Every page of Capture: the chrome. The app is the `(app)` group, whose
	layout decides the store (and whose root guards leaving while a write to
	it is out); the sign-in callback is outside it.
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
