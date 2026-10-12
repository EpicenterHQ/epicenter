<script lang="ts">
	import { Button } from '@epicenter/ui/button';
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
	// modules opens nothing, and no page opens a folder of its own. If the
	// folder cannot be opened, the same holder lets the window be closed.
	// One cache for the session: the files it shows, and every write and action.
	const queryClient = new QueryClient();
	const { opening, quit, release } = mountSession(queryClient);

	onDestroy(release);

	// The failed window's own quit, pressed by the person. Nothing answers for
	// them: a failure that proves nothing about what was left open is never
	// approved without this press.
	let quitting = $state(false);
	let quitProblem = $state<string | undefined>();
	async function quitApp() {
		if (quit === undefined) return;
		quitting = true;
		quitProblem = await quit();
		quitting = false;
	}
</script>

{#snippet failed(message: string)}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Title>Could not open the recordings folder</Empty.Title>
		<Empty.Description>{message}</Empty.Description>
		{#if quit}
			<Empty.Content>
				<Button variant="outline" disabled={quitting} onclick={() => void quitApp()} data-testid="failed-quit">
					Quit Whispering
				</Button>
				{#if quitProblem}
					<p class="text-sm text-muted-foreground" role="status">{quitProblem}</p>
				{/if}
			</Empty.Content>
		{/if}
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
