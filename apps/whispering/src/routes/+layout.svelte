<script lang="ts">
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { ModeWatcher } from 'mode-watcher';
	import { onDestroy } from 'svelte';
	import { mountSession } from '$lib/session.svelte.js';
	import AppShell from './components/AppShell.svelte';
	import '@epicenter/ui/app.css';
	// Whispering's brand overrides, layered after the shared theme so they win.
	import '../app.css';

	let props = $props();

	// The mounted layout acquires the folder, once, and every page below shares
	// it: a route change renders another page inside the same session. Importing
	// modules opens nothing, and no page opens a folder of its own.
	// One cache for the session: the files it shows, and every write and action.
	const queryClient = new QueryClient();
	const { opening, release } = mountSession(queryClient);

	onDestroy(release);
</script>

{#snippet failed(message: string)}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Title>Could not open the recordings folder</Empty.Title>
		<Empty.Description>{message}</Empty.Description>
	</Empty.Root>
{/snippet}

<svelte:head><title>Whispering</title></svelte:head>

<QueryClientProvider client={queryClient}>
<Tooltip.Provider>
	{#await opening}
		<Loading class="h-dvh" label="Opening your recordings…" />
	{:then { data: session, error: openError }}
		<!-- A refused folder is shown as refused. No other storage is opened in its place. -->
		{#if openError !== null}
			{@render failed(openError.message)}
		{:else}
			<AppShell {session}>{@render props.children?.()}</AppShell>
		{/if}
	{:catch error}
		{@render failed(error instanceof Error ? error.message : String(error))}
	{/await}
</Tooltip.Provider>
</QueryClientProvider>

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
