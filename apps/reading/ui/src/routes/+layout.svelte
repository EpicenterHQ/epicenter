<!--
	Every page of Reading: the client that keeps what pages show current, the
	toasts, the delete confirmation, and the system's light or dark mode.
-->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { ModeWatcher } from 'mode-watcher';
	import { queryClient } from '$lib/app.js';
	import '../app.css';

	let { children } = $props();

</script>

<svelte:head><title>Reading</title></svelte:head>

<QueryClientProvider client={queryClient}>
	{@render children()}
</QueryClientProvider>

<ConfirmationDialog />
<Toaster
	position="bottom-center"
	offset={{ bottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
	mobileOffset={{ bottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
/>
<ModeWatcher />
