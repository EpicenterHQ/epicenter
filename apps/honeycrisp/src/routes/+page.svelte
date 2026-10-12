<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { useQueryClient } from '@tanstack/svelte-query';
	import { openNotes } from '#platform/notes-host';
	import { onDestroy } from 'svelte';
	import { createNotes, describeError, type WriteFailure } from '$lib/notes.svelte.js';
	import NotesView from './components/NotesView.svelte';

	const queryClient = useQueryClient();

	/** A write that failed was rolled back to the file; say so, and offer the text it held. */
	function writeFailed({ path, error, lost }: WriteFailure) {
		toast.error(`Could not save ${path}`, {
			description: describeError(error),
			action:
				lost === ''
					? undefined
					: {
							label: 'Copy your text',
							onClick: () => void navigator.clipboard.writeText(lost).catch(() => {}),
						},
		});
	}

	// The mounted page acquires the folder; importing modules opens nothing.
	// On the desktop, closing the window or quitting asks this page first, and
	// the page approves once every write has landed.
	const opening = openNotes({
		async create(host) {
			const notes = createNotes(host, queryClient, { onWriteFailed: writeFailed });
			await notes.load();
			return notes;
		},
		report: (cause) =>
			toast.error('Could not finish closing', {
				description: cause instanceof Error ? cause.message : String(cause),
			}),
	});

	onDestroy(() => {
		void opening.then((notes) => notes.close()).catch(() => {});
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
