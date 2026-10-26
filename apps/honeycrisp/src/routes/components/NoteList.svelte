<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as ContextMenu from '@epicenter/ui/context-menu';
	import { toast } from '@epicenter/ui/sonner';
	import PinIcon from '@lucide/svelte/icons/pin';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { format } from 'date-fns';
	import { folderLabel, type NoteEntry } from '$lib/data.js';
	import { getDateLabel } from '$lib/date-label.js';
	import { displayTitle, previewText } from '$lib/note-source.js';
	import { foldersOf, type Notes, notesOf, repairsOf, unreadableOf } from '$lib/notes.svelte.js';
	import { confirmDelete } from './file-actions.js';

	let { notes, openListed }: { notes: Notes; openListed: (path: string) => void } = $props();

	// Filtering by fields and searching bodies reads every landed note row.
	// An edit appears here once its save lands.
	const noteRows = $derived(notes.folder.tables.notes.rows);
	const folderRows = $derived(notes.folder.tables.folders.rows);
	const all = $derived(notesOf(noteRows));
	const folders = $derived(foldersOf(folderRows));
	const repairs = $derived(repairsOf(noteRows));
	const unreadable = $derived(unreadableOf(noteRows, folderRows));
	const selectedPath = $derived(notes.selected?.path);

	const pathOf = (note: NoteEntry) => note.path;

	/** What a row shows: the note as last saved. */
	function shown(note: NoteEntry) {
		return {
			title: displayTitle(note.fields.title, note.body),
			preview: previewText(note.body),
		};
	}

	const created = (note: NoteEntry) => note.fields.createdAt;
	const isDeleted = (note: NoteEntry) => typeof note.fields.deletedAt === 'string';
	const isPinned = (note: NoteEntry) => note.fields.pinned;

	const visible = $derived.by(() => {
		const { folderId, deleted, query } = notes.view;
		const needle = query.trim().toLowerCase();
		return all
			.filter((note) => {
				const { fields } = note;
				if (isDeleted(note) !== deleted) return false;
				if (!deleted && folderId !== null && fields.folderId !== folderId) return false;
				if (needle === '') return true;
				return `${fields.title}\n${note.body}`.toLowerCase().includes(needle);
			})
			.toSorted((a, b) => created(b).localeCompare(created(a)));
	});

	const heading = $derived.by(() => {
		if (notes.view.deleted) return 'Recently Deleted';
		const id = notes.view.folderId;
		if (id === null) return 'All Notes';
		const folder = folders.find((item) => item.id === id);
		return folder === undefined ? 'Notes' : folderLabel(folder);
	});

	const groups = $derived.by(() => {
		const result: { label: string; entries: NoteEntry[] }[] = [];
		const push = (label: string, note: NoteEntry) => {
			const last = result.at(-1);
			if (last?.label === label) last.entries.push(note);
			else result.push({ label, entries: [note] });
		};
		for (const note of visible.filter(isPinned)) push('Pinned', note);
		for (const note of visible.filter((item) => !isPinned(item)))
			push(getDateLabel(created(note)), note);
		return result;
	});

	async function report(action: string, problem: ReturnType<Notes['patchNote']> | Promise<string | undefined>) {
		const message = await problem;
		if (message) toast.error(`Could not ${action}`, { description: message });
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Notes">
	<div class="flex h-11 shrink-0 items-center justify-between border-b px-3">
		<div class="flex items-center gap-2">
			<h2 class="text-sm font-semibold">{heading}</h2>
			<span class="text-xs text-muted-foreground">{visible.length}</span>
		</div>
		{#if !notes.view.deleted}
			<Button
				variant="ghost"
				size="icon-sm"
				tooltip="New note (⌘N)"
				aria-label="New note"
				onclick={() => void report('create the note', notes.createNote())}
			>
				<PlusIcon />
			</Button>
		{/if}
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto p-2">
		{#if visible.length === 0 && (notes.view.deleted || repairs.length === 0)}
			<p class="p-6 text-center text-sm text-muted-foreground">
				{notes.view.deleted ? 'No deleted notes' : 'No notes here yet. Press + to create one.'}
			</p>
		{/if}
		{#if !notes.view.deleted && repairs.length > 0}
			<!-- Shown in every folder, so a note that needs repair cannot go missing. -->
			<h3 class="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">Needs repair</h3>
			{#each repairs as repair (repair.path)}
				<ContextMenu.Root>
					<ContextMenu.Trigger>
						<button
							class="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-accent/40"
							class:bg-accent={selectedPath === repair.path}
							data-note={repair.path}
							aria-current={selectedPath === repair.path ? 'true' : undefined}
							onclick={() => openListed(repair.path)}
						>
							<span class="line-clamp-1 font-mono text-xs">{repair.path}</span>
							<span class="line-clamp-2 text-xs text-destructive">{repair.message}</span>
						</button>
					</ContextMenu.Trigger>
					<ContextMenu.Content class="w-52">
						<ContextMenu.Item onSelect={() => openListed(repair.path)}>
							Open to repair
						</ContextMenu.Item>
						<ContextMenu.Item
							variant="destructive"
							onSelect={() => void confirmDelete(notes, repair.path)}
						>
							Delete file…
						</ContextMenu.Item>
					</ContextMenu.Content>
				</ContextMenu.Root>
			{/each}
		{/if}
		{#each groups as group (group.label)}
			<h3 class="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">{group.label}</h3>
			{#each group.entries as note (note.id)}
				{@const path = pathOf(note)}
				{@const row = shown(note)}
				<ContextMenu.Root>
					<ContextMenu.Trigger>
						<button
							class="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-accent/40"
							class:bg-accent={selectedPath === path}
							data-note={path}
							aria-current={selectedPath === path ? 'true' : undefined}
							onclick={() => openListed(path)}
						>
							<span class="flex items-start justify-between gap-2">
								<span class="line-clamp-1 text-sm font-medium">
									{#if isPinned(note)}<PinIcon class="mr-1 inline size-3 fill-current align-baseline" />{/if}
									{row.title}
								</span>
								<span class="shrink-0 text-xs text-muted-foreground">
									{format(new Date(created(note)), 'h:mm a')}
								</span>
							</span>
							<span class="line-clamp-2 text-xs text-muted-foreground">{row.preview || 'No text'}</span>
						</button>
					</ContextMenu.Trigger>
					<ContextMenu.Content class="w-52">
						{#if isDeleted(note)}
							<ContextMenu.Item onSelect={() => void report('restore the note', notes.restoreNote(path))}>
								Restore
							</ContextMenu.Item>
							<ContextMenu.Item variant="destructive" onSelect={() => void confirmDelete(notes, path)}>
								Delete permanently…
							</ContextMenu.Item>
						{:else}
							<ContextMenu.Item
								onSelect={() => void report('pin the note', notes.patchNote(path, { pinned: !isPinned(note) }))}
							>
								{isPinned(note) ? 'Unpin' : 'Pin'}
							</ContextMenu.Item>
							<ContextMenu.Sub>
								<ContextMenu.SubTrigger>Move to folder</ContextMenu.SubTrigger>
								<ContextMenu.SubContent class="w-48 max-h-(--bits-menu-content-available-height) overflow-y-auto">
									<ContextMenu.Item
										onSelect={() => void report('move the note', notes.patchNote(path, { folderId: null }))}
									>
										No folder
									</ContextMenu.Item>
									<ContextMenu.Separator />
									{#each folders as folder (folder.id)}
										<ContextMenu.Item
											onSelect={() =>
												void report('move the note', notes.patchNote(path, { folderId: folder.id }))}
										>
											{folderLabel(folder)}
										</ContextMenu.Item>
									{/each}
								</ContextMenu.SubContent>
							</ContextMenu.Sub>
							<ContextMenu.Separator />
							<ContextMenu.Item
								variant="destructive"
								onSelect={() => void report('delete the note', notes.trashNote(path))}
							>
								Move to Recently Deleted
							</ContextMenu.Item>
						{/if}
					</ContextMenu.Content>
				</ContextMenu.Root>
			{/each}
		{/each}

		{#if unreadable.length > 0}
			<h3 class="px-2 pt-3 pb-1 text-xs font-medium text-muted-foreground">Cannot be opened here</h3>
			{#each unreadable as item (item.path)}
				<div class="rounded-lg px-3 py-2">
					<p class="font-mono text-xs">{item.path}</p>
					<p class="text-xs text-muted-foreground">{item.message}</p>
				</div>
			{/each}
			<p class="px-3 pt-1 text-xs text-muted-foreground">
				These files are still in the folder. Repair or delete them from Files.
			</p>
		{/if}
	</div>
</section>
