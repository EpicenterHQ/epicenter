<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import FolderApp from '@epicenter/svelte/folder-app';
	import { createWorkspace, openWhisperingFolder } from '$lib/workspace/index.js';
	import WhisperingApp from './components/WhisperingApp.svelte';
	import '@epicenter/ui/app.css';
	// Whispering's brand overrides, layered after the shared theme so they win.
	import '../app.css';

	let props = $props();

	// FolderApp opens once for this layout and closes after WhisperingApp stops;
	// route changes render inside.
</script>

<svelte:head><title>Whispering</title></svelte:head>

<Tooltip.Provider>
	<FolderApp open={openWhisperingFolder}>
		{#snippet children(context)}
			<WhisperingApp {context} workspace={createWorkspace(context.folder)}>
				{@render props.children?.()}
			</WhisperingApp>
		{/snippet}
	</FolderApp>
</Tooltip.Provider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
