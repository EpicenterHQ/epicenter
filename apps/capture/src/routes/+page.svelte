<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { onDestroy } from 'svelte';
	import { hostSignals, openCaptureHost } from '#platform/folder';
	import { createCaptures } from '$lib/captures.svelte.js';
	import CaptureApp from '$lib/components/CaptureApp.svelte';

	// The mounted page acquires the folder; importing modules opens nothing.
	// Which folder is the build's choice: a browser folder, or the desktop
	// shell's directory. There is no sign-in on this path.
	const stops: (() => void)[] = [];
	const opening = (async () => {
		const host = await openCaptureHost();
		const captures = createCaptures(host);
		void hostSignals
			.stopped?.(() => captures.markServiceStopped())
			.then((stop) => stops.push(stop), () => {});
		await captures.refresh();
		return captures;
	})();

	onDestroy(() => {
		for (const stop of stops.splice(0)) stop();
		void opening.then((captures) => captures.close()).catch(() => {});
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
