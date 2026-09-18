<script lang="ts">
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import '@epicenter/ui/app.css';

	let { children } = $props();

</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>

<Toaster offset={16} closeButton />
<!-- Both of these are mounted HERE, above the boot node, and that placement is
     load-bearing rather than tidy. `Forget this device` closes the session
     before it erases, which unmounts the shell and the account popover that
     opened the dialog; a dialog or a toast mounted under the shell would go
     with it, taking the confirmation mid-flight and the failure message with
     it. `confirmationDialog.open()` writes global state that only a mounted
     `ConfirmationDialog` renders, so without this the button does nothing at
     all. -->
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
<FlushEditsOnHide />
