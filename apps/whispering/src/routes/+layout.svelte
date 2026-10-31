<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { page } from '$app/state';
	import { desktop } from '#platform/desktop';
	import WhisperingRoot from './components/WhisperingRoot.svelte';
	import '@epicenter/ui/app.css';
	// Whispering's brand overrides, layered after the shared theme so they win.
	import '../app.css';

	let props = $props();

	// The root opens Whispering's files once for the layout, this browser's
	// or, in the desktop app, its folder (`#platform/desktop`, chosen by the
	// build); route changes render inside. The sign-in callback opens
	// nothing: it finishes sign-in and loads the page it started from.
</script>

<svelte:head><title>Whispering</title></svelte:head>

<Tooltip.Provider>
	{#if page.route.id === '/auth/callback'}
		{@render props.children?.()}
	{:else if desktop}
		<desktop.Root>{@render props.children?.()}</desktop.Root>
	{:else}
		<WhisperingRoot>
			{@render props.children?.()}
		</WhisperingRoot>
	{/if}
</Tooltip.Provider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
