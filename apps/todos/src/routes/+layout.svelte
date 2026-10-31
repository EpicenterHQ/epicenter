<!--
	Every page of Todos: the chrome and the leave guard. The app is the
	`(app)` group, whose layout decides the store; the sign-in callback is
	outside it.
-->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import '@epicenter/ui/app.css';

	let props = $props();

	// Leaving while a save is out asks first.
	onMount(guardLeave);
</script>

<svelte:head><title>Todos</title></svelte:head>

<Tooltip.Provider>{@render props.children?.()}</Tooltip.Provider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
