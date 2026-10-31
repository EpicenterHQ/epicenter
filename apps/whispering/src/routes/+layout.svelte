<!--
	Every page of Whispering: the chrome and the leave guard. The web build
	is the local variant, the `(local)` group at `/`, which opens this
	browser's files; the sign-in callback is outside it and opens nothing: it
	finishes sign-in and loads the page it started from.
-->
<script lang="ts">
	import { guardLeave } from '@epicenter/svelte/leave-guard';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import '@epicenter/ui/app.css';
	// Whispering's brand overrides, layered after the shared theme so they win.
	import '../app.css';

	let props = $props();

	// Leaving while a save is out asks first.
	onMount(guardLeave);
</script>

<svelte:head><title>Whispering</title></svelte:head>

<Tooltip.Provider>
	{@render props.children?.()}
</Tooltip.Provider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
