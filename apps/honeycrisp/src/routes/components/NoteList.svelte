<script lang="ts">
	import { createNote } from '$lib/notes.js';
	import type { ReactiveData } from '@epicenter/svelte';
	import type { HoneycrispData } from '$lib/data.js';
	import type { Note } from '$lib/data';
	import { Button } from '@epicenter/ui/button';
	import * as ScrollArea from '@epicenter/ui/scroll-area';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { navigation } from '$lib/navigation.svelte.js';
	import { getDateLabel } from '$lib/date-label.js';
	import NoteCard from '../components/NoteCard.svelte';

	let props: { data: ReactiveData<HoneycrispData> } = $props();

	const visibleNotes = $derived(
		props.data.tables.notes.rows
			.filter((note) => {
				if (navigation.isDeletedView) return note.deletedAt !== null;
				return note.deletedAt === null
					&& (navigation.folderId === null || note.folderId === navigation.folderId)
					&& note.title.toLowerCase().includes(navigation.query.trim().toLowerCase());
			})
			.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
	);

	const title = $derived.by(() => {
		if (navigation.isDeletedView) return 'Recently Deleted';
		const folderId = navigation.folderId;
		if (folderId === null) return 'All Notes';
		return props.data.tables.folders.get(folderId)?.name ?? 'Notes';
	});

	/**
	 * What to say when there is nothing at all to look at.
	 *
	 * "No notes yet" is a claim about the person's history, and it is only true
	 * when the unreadable group below is empty too: a note this release cannot
	 * INTERPRET is a row that is intact and present (ADR-0125), and it has its
	 * own group rather than a sentence standing in for the list.
	 */
	const emptyMessage = $derived(
		navigation.isDeletedView
			? 'No deleted notes'
			: 'No notes yet. Click + to create one.',
	);

	/**
	 * The notes in this table that this release cannot read (ADR-0125,
	 * ADR-0338).
	 *
	 * Shown as its own group rather than folded into the list, because there is
	 * no editor to open on one: `openContent` reaches a note through `get`,
	 * which answers `undefined` for a row that does not conform. Writes would
	 * work (the store admits an update to a row it cannot read, which is how a
	 * repair is composed), and none are offered anyway: the repair this release
	 * has is the file, and half a menu that pins a note nobody can open is not
	 * the other half.
	 *
	 * A push from the folder can produce one on purpose, so one broken note
	 * among a hundred has to be visible with the ninety-nine rather than only
	 * when the list is otherwise empty.
	 *
	 * Unfiltered by the folder, the query, and the deleted view alike. Which of
	 * those a note belongs in is read off values this release could not read, so
	 * hiding it under any of them is how it becomes invisible again. The count
	 * beside the title stays the count of notes this release reads, for the same
	 * reason: it counts a list, and these are not in it.
	 */
	const unreadableNotes = $derived(props.data.tables.notes.nonconforming);

	/** The name a person has for a note whose title did not survive. */
	function nameOf(row: { id: string; raw: { title?: unknown } }): string {
		return typeof row.raw.title === 'string' && row.raw.title !== ''
			? row.raw.title
			: row.id;
	}

	// Grouping only: `visibleNotes` already owns the order (newest edit first),
	// so the pinned partition and the date labels preserve it.
	const groupedNotes = $derived.by(() => {
		const notes = visibleNotes;
		const pinned = notes.filter((n) => n.pinned);
		const unpinned = notes.filter((n) => !n.pinned);

		const groups: { label: string; entries: Note[] }[] = [];

		if (pinned.length > 0) {
			groups.push({ label: 'Pinned', entries: pinned });
		}

		let currentLabel = '';
		let currentGroup: Note[] = [];

		for (const note of unpinned) {
			const label = getDateLabel(note.updatedAt);
			if (label !== currentLabel) {
				if (currentGroup.length > 0) {
					groups.push({ label: currentLabel, entries: currentGroup });
				}
				currentLabel = label;
				currentGroup = [note];
			} else {
				currentGroup.push(note);
			}
		}

		if (currentGroup.length > 0) {
			groups.push({ label: currentLabel, entries: currentGroup });
		}

		return groups;
	});

	/** Flat list of note IDs in display order for arrow key navigation. */
	const flatNoteIds = $derived(
		groupedNotes.flatMap((g) => g.entries.map((n) => n.id)),
	);

</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="flex h-full flex-col"
	onkeydown={(e) => {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		if (flatNoteIds.length === 0) return;
		e.preventDefault();

		const currentIndex = navigation.noteId
			? flatNoteIds.indexOf(navigation.noteId)
			: -1;

		if (e.key === 'ArrowDown') {
			const nextIndex =
				currentIndex < flatNoteIds.length - 1 ? currentIndex + 1 : 0;
			navigation.selectNote(flatNoteIds[nextIndex]!);
		} else {
			const prevIndex =
				currentIndex > 0 ? currentIndex - 1 : flatNoteIds.length - 1;
			navigation.selectNote(flatNoteIds[prevIndex]!);
		}
	}}
	tabindex="-1"
>
	<div class="flex items-center justify-between border-b px-4 py-3">
		<div class="flex items-center gap-2">
			<h2 class="text-sm font-semibold">
				{title}
			</h2>
			<span class="text-xs text-muted-foreground"
				>{visibleNotes.length}</span
			>
		</div>
		{#if !navigation.isDeletedView}
			<div class="flex items-center gap-1">
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					tooltip="New note"
					aria-label="New note"
					onclick={() =>
						createNote(props.data)}
				>
					<PlusIcon class="size-4" />
				</Button>
			</div>
		{/if}
	</div>

	<ScrollArea.Root class="flex-1">
		<div class="flex flex-col gap-4 p-2">
			{#if visibleNotes.length === 0}
				<!--
					Still said when the unreadable group is not empty, because it is
					still true: "No deleted notes" is a claim about this view, and a
					note nothing can read is in no view.
				-->
				<p class="p-6 text-center text-sm text-muted-foreground">
					{emptyMessage}
				</p>
			{/if}
			{#each groupedNotes as group}
				<div class="flex flex-col gap-0.5">
					<h3 class="px-2 pb-1 text-xs font-medium text-muted-foreground">
						{group.label}
					</h3>
					{#each group.entries as note (note.id)}
						<NoteCard
							data={props.data}
							{note}
							isSelected={note.id === navigation.noteId}
							onSelect={() => navigation.selectNote(note.id)}
						/>
					{/each}
				</div>
			{/each}

			<!--
				Last, and not selectable. There is nothing to open on a note whose
				values this release could not read, and the repair a person has is
				the file, on a build that has one.
			-->
			{#if unreadableNotes.length > 0}
				<div class="flex flex-col gap-0.5">
					<h3 class="px-2 pb-1 text-xs font-medium text-muted-foreground">
						This version cannot read
					</h3>
					{#each unreadableNotes as note (note.id)}
						<div class="rounded-lg px-3 py-2">
							<p class="line-clamp-1 text-sm font-medium">{nameOf(note)}</p>
							<ul class="mt-0.5 text-xs text-muted-foreground">
								{#each note.issues as issue (issue.field)}
									<li>{issue.field}: {issue.message}</li>
								{/each}
							</ul>
						</div>
					{/each}
					<p class="px-3 pt-1 text-xs text-muted-foreground">
						These notes are still stored, but this version cannot open them.
					</p>
				</div>
			{/if}
		</div>
	</ScrollArea.Root>
</div>
