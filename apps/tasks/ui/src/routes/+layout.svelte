<!--
	Every page of Tasks: the toasts, the delete confirmation, the system's
	light or dark mode, and the list kept current while the page is visible.
-->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import { tasks } from '$lib/store.svelte.js';
	import '../app.css';

	let { children } = $props();

	$effect(() => tasks.watch());
</script>

<svelte:head><title>Tasks</title></svelte:head>

{@render children()}

<ConfirmationDialog />
<Toaster
	position="bottom-center"
	offset={{ bottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
	mobileOffset={{ bottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
/>
<ModeWatcher />
