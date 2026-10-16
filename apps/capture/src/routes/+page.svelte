<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { useQueryClient } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { openCaptureHost } from '#platform/folder';
	import {
		createCaptures,
		describeError,
		type WriteFailure,
	} from '$lib/captures.svelte.js';
	import CaptureApp from '$lib/components/CaptureApp.svelte';

	// The mounted page acquires the folder; importing modules opens nothing.
	// Which folder is the build's choice: a browser folder, or the desktop
	// shell's directory. There is no sign-in on this path. Quitting Epicenter
	// asks this page nothing (ADR-0542).
	const queryClient = useQueryClient();

	/** A write failed; say so, and offer the text that is not in the file. */
	function writeFailed({ path, error, text }: WriteFailure) {
		toast.error(`Could not save ${path}`, {
			description: describeError(error),
			duration: Number.POSITIVE_INFINITY,
			action:
				text === ''
					? undefined
					: {
							label: 'Copy your text',
							onClick: () => void navigator.clipboard.writeText(text).catch(() => {}),
						},
		});
	}

	const opening = (async () => {
		const host = await openCaptureHost();
		const captures = createCaptures(host, queryClient, {
			onWriteFailed: writeFailed,
		});
		// Files changed outside this page mark what the views show as stale.
		const stopChanges = captures.folder$.invalidateOnChange(queryClient);
		return { host, captures, stopChanges };
	})();

	onDestroy(() => {
		void opening
			.then(async ({ host, captures, stopChanges }) => {
				stopChanges();
				await captures.close();
				return host.close();
			})
			.catch(() => {});
	});
</script>

{#await opening}
	<Loading class="h-dvh" label="Opening your captures…" />
{:then { captures }}
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
