<!--
	One open note. The view reads the note listing narrowed to this note, so it
	never disagrees with the list. Its title, folder, pin, rich text, and Source
	are edits to that cache, and each writes at once. The rich-text view stays
	mounted while the note is open, a rename included, so its undo history
	survives writes; it starts over only when the note's text changes under it.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import * as Tabs from '@epicenter/ui/tabs';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import PinIcon from '@lucide/svelte/icons/pin';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { type Row, wellFormed } from '@epicenter/folder';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { createQuery } from '@tanstack/svelte-query';
	import { folderLabel, type NoteFields, noteIdOf } from '$lib/data.js';
	import { withBody } from '$lib/note-source.js';
	import { foldersOf, type Notes } from '$lib/notes.svelte.js';
	import { confirmDelete } from './file-actions.js';
	import NoteHistory from './NoteHistory.svelte';
	import RichEditor from './RichEditor.svelte';

	let {
		notes,
		path,
	}: {
		notes: Notes;
		/** The note shown. It follows a rename; the parent keys this view by its opening. */
		path: string;
	} = $props();

	const stem = $derived(noteIdOf(path));
	const note = createQuery(() =>
		notes.notesQuery((listing) => listing.find((entry) => entry.stem === stem)),
	);
	const folders = createQuery(() => notes.foldersQuery(foldersOf));
	/** The note as the rich-text view reads and edits it. */
	const body = $derived(notes.noteBody(path));
	/** Edits wait once the notes are closing, and while this file is renamed or deleted. */
	const locked = $derived(notes.isLocked(path));

	/** Which view of the note shows. Switching writes nothing and discards nothing. */
	let tab = $state<'rich' | 'source'>('rich');
	let historyOpen = $state(false);

	/** Change the note in the cache, which writes it; say so when it was refused. */
	function set(change: (row: Row<NoteFields>) => Row<NoteFields>) {
		const problem = notes.editNote(path, change);
		if (problem) toast.warning('That change was not made', { description: problem });
	}

	/** Textareas report LF; the setter restores the file's own line endings. */
	const lf = (text: string) => text.replace(/\r\n?/g, '\n');

	function setBody(value: string) {
		set((row) => withBody(row, wellFormed(withFileNewlines(value, row.body))));
	}

	async function report(action: string, problem: string | undefined) {
		if (problem) toast.error(`Could not ${action}`, { description: problem });
	}

	/** A folder's option value. No folder is the empty value, so a folder id never is. */
	const optionOf = (id: string | null) => (id === null ? '' : `folder:${id}`);
	const idOf = (option: string) => (option === '' ? null : option.slice('folder:'.length));
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Note">
	{#if note.data?.result.error === null}
		{@const row = note.data.result.data.row}
		{@const folderId = row.fields.folderId}
		{@const pinned = row.fields.pinned}
		{@const deleted = typeof row.fields.deletedAt === 'string'}
		<div class="flex items-center gap-2 border-b px-3 py-2">
			<Input
				class="flex-1 text-base font-medium"
				bind:value={
					() => row.fields.title,
					(title) => set((r) => ({ ...r, fields: { ...r.fields, title: wellFormed(title) } }))
				}
				disabled={locked}
				placeholder="Title"
				aria-label="Title"
			/>
			<select
				class="h-9 max-w-40 rounded-md border bg-background px-2 text-sm"
				aria-label="Folder"
				value={optionOf(folderId)}
				disabled={locked}
				onchange={(event) => {
					const next = idOf(event.currentTarget.value);
					set((r) => ({ ...r, fields: { ...r.fields, folderId: next } }));
				}}
			>
				<option value="">No folder</option>
				{#each folders.data ?? [] as folder (folder.path)}
					<option value={optionOf(folder.stem)}>{folderLabel(folder)}</option>
				{/each}
				{#if folderId !== null && !(folders.data ?? []).some((folder) => folder.stem === folderId)}
					<option value={optionOf(folderId)}>{folderId} (missing)</option>
				{/if}
			</select>
			<Button
				variant={pinned ? 'secondary' : 'ghost'}
				size="icon-sm"
				aria-label={pinned ? 'Unpin' : 'Pin'}
				aria-pressed={pinned}
				tooltip={pinned ? 'Unpin' : 'Pin'}
				disabled={locked}
				onclick={() => set((r) => ({ ...r, fields: { ...r.fields, pinned: !r.fields.pinned } }))}
			>
				<PinIcon class={pinned ? 'fill-current' : ''} />
			</Button>
			{#if notes.host.history}
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="History"
					tooltip="Saved versions of this note"
					onclick={() => (historyOpen = true)}
				>
					<HistoryIcon />
				</Button>
			{/if}
		</div>

		<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col">
			<Tabs.List class="mx-3">
				<Tabs.Trigger value="rich">Rich text</Tabs.Trigger>
				<Tabs.Trigger value="source">Source</Tabs.Trigger>
			</Tabs.List>
			<!-- The rich-text view stays mounted while Source shows, so its undo history
			     survives a look at the source that changes nothing. -->
			<Tabs.Content value="rich" forceMount class="min-h-0 flex-1">
				<RichEditor
					note={body}
					focusRequest={notes.focusRequest}
					onOpenSource={() => (tab = 'source')}
					onRefuse={(reason) => toast.warning('That edit was not made', { description: reason })}
				/>
			</Tabs.Content>
			<Tabs.Content value="source" class="flex min-h-0 flex-1 flex-col">
				<div class="flex min-h-0 flex-1 flex-col p-3">
					<Textarea
						class="min-h-40 flex-1 resize-none font-mono text-xs"
						bind:value={() => lf(row.body), setBody}
						disabled={locked}
						aria-label="Markdown source"
						spellcheck={false}
					/>
				</div>
			</Tabs.Content>
		</Tabs.Root>

		<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
			<span role="status" data-testid="write-status">
				{notes.isWriting(path) ? 'Saving…' : 'Saved to'}
				<code class="font-mono">{path}</code>
			</span>
			<Button
				size="sm"
				variant="ghost"
				tooltip="Edit the whole file as text, including keys Honeycrisp does not show"
				onclick={() => notes.open(path, 'text')}
			>
				Edit as file
			</Button>
			<div class="ml-auto flex items-center gap-1">
				{#if deleted}
					<Button
						size="sm"
						variant="outline"
						disabled={locked}
						onclick={() => void report('restore the note', notes.restoreNote(path))}
					>
						Restore
					</Button>
					<Button size="sm" variant="ghost-destructive" disabled={locked} onclick={() => void confirmDelete(notes, path)}>
						Delete permanently
					</Button>
				{:else}
					<Button
						size="sm"
						variant="ghost-destructive"
						disabled={locked}
						onclick={() => void report('delete the note', notes.trashNote(path))}
					>
						Move to Recently Deleted
					</Button>
				{/if}
			</div>
		</div>
	{:else if note.data?.result.error}
		{@const error = note.data.result.error}
		<Empty.Root class="flex-1" data-testid="needs-repair">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			{#if error.name === 'InvalidRow'}
				<Empty.Title><Badge variant="destructive">Needs repair</Badge> This file does not read as a note</Empty.Title>
				<Empty.Description>
					<code class="font-mono">{path}</code>: {error.issues.map((issue) => issue.message).join(' ')}
				</Empty.Description>
				<Button variant="outline" size="sm" onclick={() => notes.open(path, 'text')}>Repair as text</Button>
			{:else}
				<Empty.Title>Could not read this note</Empty.Title>
				<Empty.Description>{error.message}</Empty.Description>
				<Button variant="outline" size="sm" onclick={() => void notes.refresh()}>Try again</Button>
			{/if}
		</Empty.Root>
	{:else if note.isSuccess}
		<Empty.Root class="flex-1">
			<Empty.Title>This note is no longer in the folder</Empty.Title>
			<Empty.Description>It was renamed or deleted, here or by another program.</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void notes.refresh()}>Check again</Button>
		</Empty.Root>
	{:else if note.isError}
		<Empty.Root class="flex-1">
			<Empty.Title>Could not read the notes folder</Empty.Title>
			<Empty.Description>{note.error.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void note.refetch()}>Try again</Button>
		</Empty.Root>
	{:else}
		<Loading class="flex-1" label="Opening the note…" />
	{/if}
</section>

{#if notes.host.history && historyOpen}
	<NoteHistory
		history={notes.host.history}
		{path}
		admitting={!locked}
		onUse={(source) => notes.useVersion(path, source)}
		bind:open={historyOpen}
	/>
{/if}
