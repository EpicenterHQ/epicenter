<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { onDestroy } from 'svelte';
	import { createLogger } from 'wellcrafted/logger';
	import { onHostStopped, openCaptureHost } from '#platform/folder';
	import { onCloseRequested } from '#platform/window';
	import { type Captures, createCaptures } from '$lib/captures.svelte.js';
	import CaptureApp from '$lib/components/CaptureApp.svelte';

	const log = createLogger('capture/page');

	// The mounted page acquires the folder; importing modules opens nothing.
	// Which folder is the build's choice: a browser folder, or the desktop
	// shell's directory. There is no sign-in on this path.
	//
	// Ending the page is `close`, however it ends: it refuses new work, lets
	// running actions and saves finish, and lets go of the folder. The
	// window's close handler awaits it before the window goes, and unmounting
	// calls it too. Before the captures exist there is nothing to wait for, so
	// a close while opening, or after opening failed, goes ahead at once.
	let captures: Captures | undefined;
	async function close() {
		try {
			await captures?.close();
		} catch (cause) {
			log.warn(new Error('Closing the captures failed.', { cause }));
		}
	}
	const listening = onCloseRequested?.(close).catch((cause: unknown) => {
		log.warn(new Error('Listening for the window to close failed.', { cause }));
		return undefined;
	});
	const stops: (() => void)[] = [];
	const opening = (async () => {
		// The handler is registered before anything can be edited.
		await listening;
		const opened = createCaptures(await openCaptureHost());
		captures = opened;
		void onHostStopped?.(() => opened.markServiceStopped()).then(
			(stop) => stops.push(stop),
			() => {},
		);
		await opened.refresh();
		return opened;
	})();

	onDestroy(() => {
		for (const stop of stops.splice(0)) stop();
		void listening?.then((stop) => stop?.());
		void opening.then(close, () => {});
	});
</script>

{#await opening}
	<Loading class="h-dvh" label="Opening your captures…" />
{:then captures}
	<CaptureApp {captures} />
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Header>
			<Empty.Title>Could not open the captures folder</Empty.Title>
			<Empty.Description role="alert">{error instanceof Error ? error.message : String(error)}</Empty.Description>
		</Empty.Header>
		<Empty.Content><Button variant="outline" size="sm" onclick={() => location.reload()}>Try again</Button></Empty.Content>
	</Empty.Root>
{/await}
