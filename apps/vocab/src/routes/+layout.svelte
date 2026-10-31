<!--
	Every page of Vocab: the chrome and the leave guard. The app is the
	`(app)` group, whose layout decides the store; the sign-in callback is
	outside it.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import '../app.css';

	let { children } = $props();

	// Leaving while a save is out asks first.
	onMount(guardLeave);
</script>

<svelte:head><title>Vocab</title></svelte:head>

<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>

<Toaster />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
