<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { useQueryClient } from '@tanstack/svelte-query';
	import { openNotes } from '#platform/notes-host';
	import { onDestroy } from 'svelte';
	import {
		createNotes,
		describeError,
		type ReplacedChange,
		type WriteFailure,
	} from '$lib/notes.svelte.js';
	import NotesView from './components/NotesView.svelte';

	const queryClient = useQueryClient();

	/** A save failed; say so, and offer the text it held. */
	function writeFailed({ path, error, unsaved, kept }: WriteFailure) {
		toast.error(`Could not save ${path}`, {
			description: kept
				? `${describeError(error)} Your edit is still on screen; it saves again with your next change.`
				: describeError(error),
			action:
				unsaved === ''
					? undefined
					: {
							label: 'Copy your text',
							onClick: () => void navigator.clipboard.writeText(unsaved).catch(() => {}),
						},
		});
	}

	/** What a value is called where a person changes it. */
	const valueNames: Record<string, string> = {
		title: 'the title',
		folderId: 'the folder',
		pinned: 'the pin',
		deletedAt: 'Recently Deleted',
		name: 'the name',
		icon: 'the icon',
	};

	/** A save replaced a change made elsewhere to the same values; name them. */
	function replacedChange({ path, replaced }: ReplacedChange) {
		const names = [
			...new Set(
				replaced.map((entry) =>
					entry.kind === 'body' ? 'the text' : (valueNames[entry.field] ?? entry.field),
				),
			),
		];
		toast.info(`Saved ${path}`, {
			description: `Your edit replaced a change made elsewhere to ${names.join(', ')}.`,
		});
	}

	// The mounted page acquires the folder; importing modules opens nothing.
	// On the desktop, closing the window quits at once: every save is an
	// atomic rename into the folder, so nothing waits here (ADR-0542).
	const opening = openNotes({
		async create(host) {
			const notes = createNotes(host, queryClient, {
				onWriteFailed: writeFailed,
				onReplaced: replacedChange,
			});
			await notes.load();
			return notes;
		},
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
