<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { flushOnClose } from '@epicenter/svelte/flush-on-close';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { hostClose, openHost } from '#platform/notes-host';
	import { onDestroy } from 'svelte';
	import { createNotes, type Notes } from '$lib/notes.svelte.js';
	import NotesView from './components/NotesView.svelte';

	// The mounted page acquires the folder; importing modules opens nothing.
	let notes: Notes | undefined;
	const opening = (async () => {
		const host = await openHost();
		try {
			const opened = createNotes(host);
			await opened.check();
			notes = opened;
			return opened;
		} catch (cause) {
			await host.close();
			throw cause;
		}
	})();

	// Closing never asks. When the window closes or the app quits, saves in
	// flight get a bounded moment to land, then the page ends. Listening from
	// the start lets a close during opening go ahead at once.
	const stopFlushing = flushOnClose(async () => notes?.flush(), { hostClose });

	onDestroy(() => {
		stopFlushing();
		void opening.then((opened) => opened.close()).catch(() => {});
	});
</script>

{#await opening}
	<Loading class="h-dvh" label="Opening your notes…" />
{:then notes}
	<NotesView {notes} />
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Title>Could not open the notes folder</Empty.Title>
		<Empty.Description>{error instanceof Error ? error.message : String(error)}</Empty.Description>
	</Empty.Root>
{/await}
