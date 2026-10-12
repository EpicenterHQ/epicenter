<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { openHost } from '#platform/notes-host';
	import { onCloseRequested } from '#platform/window';
	import { createClosing } from '@epicenter/svelte/closing';
	import ClosingNotice from '@epicenter/svelte/closing-notice';
	import { onDestroy } from 'svelte';
	import { createLogger } from 'wellcrafted/logger';
	import { createNotes, type Notes } from '$lib/notes.svelte.js';
	import NotesView from './components/NotesView.svelte';

	const log = createLogger('honeycrisp/page');

	// Ending the page is `close`, however it ends: it refuses new work, lets
	// running actions and saves finish, and releases the folder. The window's
	// close handler awaits it before the window goes, and unmounting calls it
	// too. Before the notes exist there is nothing to wait for, so a close
	// while opening, or after opening failed, goes ahead at once.
	let notes: Notes | undefined;
	async function close() {
		await notes?.close();
	}
	// The handler waits with no timeout. A close still running after a moment
	// shows "Still saving…" with Close anyway, which lets the window go.
	const closing = createClosing({ close });
	const listening = onCloseRequested?.(closing.request).catch((cause: unknown) => {
		log.warn(new Error('Listening for the window to close failed.', { cause }));
		return undefined;
	});

	// The mounted page acquires the folder; importing modules opens nothing.
	const opening = (async () => {
		// The handler is registered before anything can be edited.
		await listening;
		const host = await openHost();
		try {
			const opened = createNotes(host);
			notes = opened;
			await opened.check();
			return opened;
		} catch (cause) {
			notes = undefined;
			await host.close();
			throw cause;
		}
	})();

	onDestroy(() => {
		void listening?.then((stop) => stop?.());
		void opening.then(close).catch(() => {});
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

<ClosingNotice {closing} />
