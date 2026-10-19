<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import Page from '../../../routes/+page.svelte';

	let showing = $state(true);
</script>

<Tooltip.Provider>
	{#if showing}<Page />{/if}
	<button type="button" onclick={() => (showing = false)}>Leave page</button>
</Tooltip.Provider>
<ConfirmationDialog />
<Toaster />
