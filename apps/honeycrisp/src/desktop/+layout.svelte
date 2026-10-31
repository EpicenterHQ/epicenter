<!--
	The desktop app's root (the `HONEYCRISP_DESKTOP=1` build, whose routes are
	this folder): the same chrome as the web's, and the leave guard, which on
	desktop holds the window's close until every save, a note's body included,
	has landed.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import '@epicenter/ui/app.css';

	let props = $props();

	onMount(guardLeave);
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

<Tooltip.Provider>{@render props.children?.()}</Tooltip.Provider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
