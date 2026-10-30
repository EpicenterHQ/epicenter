<script lang="ts">
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import '@epicenter/ui/app.css';
	let { children } = $props();
</script>

<svelte:head><title>Messages</title></svelte:head>
<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
<Toaster closeButton />
