<!--
	Every page of Notes: the toasts, the delete confirmation, the system's
	light or dark mode, and the list kept current while the page is visible.
-->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { notes } from '$lib/notes.svelte.js';
	import '../app.css';

	let { children } = $props();

	$effect(() => notes.watch());
</script>

<svelte:head><title>Notes</title></svelte:head>

{@render children()}

<ConfirmationDialog />
<Toaster
	position="bottom-center"
	offset={{ bottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
	mobileOffset={{ bottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
/>
<ModeWatcher />
