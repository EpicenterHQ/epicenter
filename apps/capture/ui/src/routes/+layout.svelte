<!--
	Every page of Capture: the client that keeps what pages show current, the
	toasts, the delete confirmation, and the system's light or dark mode.
-->
<script lang="ts">
	import { createQueryClient } from '@epicenter/app/client';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { ModeWatcher } from 'mode-watcher';
	import '../app.css';

	let { children } = $props();

	const queryClient = createQueryClient();
</script>

<svelte:head><title>Capture</title></svelte:head>

<!-- Behind the iPhone's status bar, so scrolled text does not show through it. -->
<div aria-hidden="true" class="fixed inset-x-0 top-0 z-20 h-[env(safe-area-inset-top)] bg-background"></div>

<main class="safe-area mx-auto flex w-full max-w-2xl flex-col">
	<QueryClientProvider client={queryClient}>
		{@render children()}
	</QueryClientProvider>
</main>

<Toaster offset={16} closeButton position="bottom-center" />
<ConfirmationDialog />
<ModeWatcher />
