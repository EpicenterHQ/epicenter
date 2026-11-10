<!--
	Every page of Reading: the toasts, the delete confirmation, the system's
	light or dark mode, and the shelf kept current while the page is visible.
-->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { shelf } from '$lib/books.svelte.js';
	import '../app.css';

	let { children } = $props();

	$effect(() => shelf.watch());
</script>

<svelte:head><title>Reading</title></svelte:head>

{@render children()}

<ConfirmationDialog />
<Toaster
	position="bottom-center"
	offset={{ bottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
	mobileOffset={{ bottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
/>
<ModeWatcher />
