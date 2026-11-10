<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import { ModeWatcher } from 'mode-watcher';
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head><title>Capture</title></svelte:head>

<!-- Behind the iPhone's status bar, so scrolled text does not show through it. -->
<div aria-hidden="true" class="fixed inset-x-0 top-0 z-20 h-[env(safe-area-inset-top)] bg-background"></div>

<main class="safe-area mx-auto flex w-full max-w-2xl flex-col">
	{@render children()}
</main>

<Toaster offset={16} closeButton position="bottom-center" />
<ConfirmationDialog />
<ModeWatcher />
