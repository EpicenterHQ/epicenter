<!-- The Capture page as the layout mounts it: with the tooltip provider, the confirmation dialog, and the toaster. -->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import Page from '../../../routes/+page.svelte';
</script>

<Tooltip.Provider><Page /></Tooltip.Provider>
<ConfirmationDialog />
<Toaster />
