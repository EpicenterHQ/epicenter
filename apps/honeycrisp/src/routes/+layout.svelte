<!--
	Every page of Honeycrisp: the chrome. The app is the `(app)` group, whose
	layout decides the store (and guards leaving while a save is out); the
	sign-in callback is outside it.
-->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import '@epicenter/ui/app.css';

	let props = $props();
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

<Tooltip.Provider>{@render props.children?.()}</Tooltip.Provider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
