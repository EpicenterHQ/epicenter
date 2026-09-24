<script lang="ts">
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
  import '@epicenter/ui/app.css';
  let { children } = $props();
</script>

<svelte:head><title>Capture</title></svelte:head>
<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
<Toaster />
<ConfirmationDialog />
<FlushEditsOnHide />
