<!-- Test helper: the Honeycrisp page as the layout mounts it, with the tooltip provider, the confirmation dialog, and the toaster, over a repository the test opens. -->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { ComponentProps } from 'svelte';
	import OpenHoneycrisp from '../routes/components/OpenHoneycrisp.svelte';

	let props: ComponentProps<typeof OpenHoneycrisp> = $props();
</script>

<Tooltip.Provider><OpenHoneycrisp {...props} /></Tooltip.Provider>
<ConfirmationDialog />
<Toaster />
