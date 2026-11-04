<!--
	Every page of Todos: the chrome. The app is the `(app)` group, whose
	layout decides the store and asks before a page with a save out is left;
	the sign-in callback is outside it.
-->
<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import '@epicenter/ui/app.css';

	let props = $props();
</script>

<svelte:head><title>Todos</title></svelte:head>

<Tooltip.Provider>{@render props.children?.()}</Tooltip.Provider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
