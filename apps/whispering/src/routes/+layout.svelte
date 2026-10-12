<script lang="ts">
	import {
		ConfirmationDialog,
		confirmationDialog,
	} from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { ModeWatcher } from 'mode-watcher';
	import { onDestroy } from 'svelte';
	import { createLogger } from 'wellcrafted/logger';
	import { mountSession, type Session } from '$lib/session.svelte.js';
	import type { WorkspaceWindow } from '$lib/workspace/index.js';
	import AppShell from './components/AppShell.svelte';
	import '@epicenter/ui/app.css';
	// Whispering's brand overrides, layered after the shared theme so they win.
	import '../app.css';

	let props = $props();

	const log = createLogger('whispering/layout');

	// The mounted layout acquires the folder, once, and every page below shares
	// it: a route change renders another page inside the same session. Importing
	// modules opens nothing, and no page opens a folder of its own.
	const { opening, release } = mountSession();

	// Closing the desktop window ends the session: the shell awaits this
	// handler, which awaits `session.close()`, then the window goes. Only a
	// recording in progress is asked about first; Cancel keeps the window open
	// and the recording going. The handler is registered before the session is
	// shown, so nothing is editable without it. A close while opening, or
	// after opening failed, has no session to wait for and goes ahead at once.
	let session: Session | undefined;
	let stopListening: (() => void) | undefined;
	let destroyed = false;
	/** The ask on screen, which a second close request joins. */
	let asking: Promise<boolean> | undefined;

	function askToStopRecording(window: WorkspaceWindow): Promise<boolean> {
		asking ??= (async () => {
			// Quit can arrive while the window is hidden or behind others.
			await window.reveal().catch((cause: unknown) => {
				log.warn(new Error('Showing the window to ask failed.', { cause }));
			});
			return new Promise<boolean>((resolve) => {
				confirmationDialog.open({
					title: 'A recording is in progress',
					description:
						'Closing Whispering stops the recording, and what was recorded is not kept.',
					confirm: { text: 'Close', variant: 'destructive' },
					cancel: { text: 'Keep recording' },
					onConfirm: () => resolve(true),
					onCancel: () => resolve(false),
				});
			});
		})().finally(() => {
			asking = undefined;
		});
		return asking;
	}

	async function closeRequested(event: { preventDefault(): void }) {
		const current = session;
		if (current === undefined) return;
		const { window } = current.workspace;
		if (
			current.library.recording &&
			window !== undefined &&
			!(await askToStopRecording(window))
		) {
			event.preventDefault();
			return;
		}
		try {
			await current.close();
		} catch (cause) {
			log.warn(new Error('Closing the session failed.', { cause }));
		}
	}

	const ready = opening.then(async (opened) => {
		if (opened.error !== null) return opened;
		session = opened.data;
		const stop = await opened.data.workspace.window
			?.onCloseRequested(closeRequested)
			.catch((cause: unknown) => {
				log.warn(
					new Error('Listening for the window to close failed.', { cause }),
				);
				return undefined;
			});
		if (destroyed) stop?.();
		else stopListening = stop;
		return opened;
	});

	onDestroy(() => {
		destroyed = true;
		stopListening?.();
		release();
	});
</script>

{#snippet failed(message: string)}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Title>Could not open the recordings folder</Empty.Title>
		<Empty.Description>{message}</Empty.Description>
	</Empty.Root>
{/snippet}

<svelte:head><title>Whispering</title></svelte:head>

<Tooltip.Provider>
	{#await ready}
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

<ConfirmationDialog />
<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
