<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import OpenFolder from '@epicenter/svelte/open-folder';
	import { openFolder } from '@epicenter/folder/next';
	import { whisperingTables } from '$lib/definition.js';
	import { page } from '$app/state';
	import WhisperingApp from './components/WhisperingApp.svelte';
	import '@epicenter/ui/app.css';
	// Whispering's brand overrides, layered after the shared theme so they win.
	import '../app.css';

	let props = $props();

	// OpenFolder opens once for this layout and closes after WhisperingApp stops;
	// route changes render inside.
</script>

<svelte:head><title>Whispering</title></svelte:head>

<Tooltip.Provider>
	{#if page.route.id === '/auth/callback'}
		{@render props.children?.()}
	{:else}
	<OpenFolder open={() => openFolder({ tables: whisperingTables })}>
		{#snippet children(folder)}
			<WhisperingApp {folder}>
				{@render props.children?.()}
			</WhisperingApp>
		{/snippet}
	</OpenFolder>
	{/if}
</Tooltip.Provider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
