<!-- The Todos page as the layout mounts it, with the tooltip provider, the confirmation dialog and the toaster, over a repository the test opens. -->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { ComponentProps } from 'svelte';
	import OpenTodos from '../OpenTodos.svelte';

	let props: ComponentProps<typeof OpenTodos> = $props();
</script>

<Tooltip.Provider><OpenTodos {...props} /></Tooltip.Provider>
<ConfirmationDialog />
<Toaster />
