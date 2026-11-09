<script lang="ts">
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head><title>Capture</title></svelte:head>

{@render children()}

<Toaster offset={16} closeButton />
<ModeWatcher />
