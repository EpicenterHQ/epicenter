<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { useQueryClient } from '@tanstack/svelte-query';
	import { openForDeparture } from '@epicenter/epicenter/departure/page';
	import { onDestroy } from 'svelte';
	import { openCaptureHost, openDeparture } from '#platform/folder';
	import { createCaptures, describeError, type WriteFailure } from '$lib/captures.svelte.js';
	import CaptureApp from '$lib/components/CaptureApp.svelte';

	// The mounted page acquires the folder; importing modules opens nothing.
	// Which folder is the build's choice: a browser folder, or the desktop
	// shell's directory. There is no sign-in on this path.
	//
	// On the desktop, the host's departure question is heard before the folder
	// opens, and the folder opens only once a status is known, so nothing is
	// editable while a quit or restart may be running. The captures are
	// attached before anything else is awaited; a folder that did not open
	// has nothing to settle. A browser tab has none.
	const queryClient = useQueryClient();

	/** A write that failed was rolled back to the file; say so, and offer the text it held. */
	function writeFailed({ path, error, lost }: WriteFailure) {
		toast.error(`Could not save ${path}`, {
			description: describeError(error),
			duration: Number.POSITIVE_INFINITY,
			action:
				lost === ''
					? undefined
					: {
							label: 'Copy your text',
							onClick: () => void navigator.clipboard.writeText(lost).catch(() => {}),
						},
		});
	}

	const departure = openDeparture();
	void departure?.start();
	const opening = openForDeparture(
		departure,
		async () => {
			const host = await openCaptureHost();
			return {
				host,
				captures: createCaptures(host, queryClient, { onWriteFailed: writeFailed }),
			};
		},
		({ captures }) => captures.departure,
	);

	onDestroy(() => {
		departure?.destroy();
		void opening
			.then(async ({ host, captures }) => {
				await captures.close();
				return host.close();
			})
			.catch(() => {});
	});
</script>

{#await opening}
	{#if departure !== undefined && !departure.known && departure.problem !== undefined}
		<Empty.Root class="h-dvh">
			<Empty.Header>
				<Empty.Title>Capture cannot hear Epicenter</Empty.Title>
				<Empty.Description role="alert">Capture opens once it can tell whether Epicenter is quitting or restarting, so no text is lost to one: {departure.problem}</Empty.Description>
			</Empty.Header>
			<Empty.Content><Button variant="outline" size="sm" onclick={() => void departure.start()}>Try again</Button></Empty.Content>
		</Empty.Root>
	{:else}
		<Loading class="h-dvh" label="Opening your captures…" />
	{/if}
{:then { captures }}
	<CaptureApp {captures} {departure} />
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Header>
			<Empty.Title>Could not open the captures folder</Empty.Title>
			<Empty.Description role="alert">{error instanceof Error ? error.message : String(error)}</Empty.Description>
		</Empty.Header>
		<Empty.Content><Button variant="outline" size="sm" disabled={departure?.fenced} onclick={() => location.reload()}>Try again</Button></Empty.Content>
	</Empty.Root>
{/await}
