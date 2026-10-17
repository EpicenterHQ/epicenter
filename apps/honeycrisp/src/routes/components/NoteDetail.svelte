<!--
	One open note. The view reads the note listing narrowed to this note, so it
	never disagrees with the list. Its folder and pin are sent at once, and its
	title a second after the last keystroke, when the person leaves it, and
	when the view goes away: each a set of the file as it is now
	(ADR-0576). Its rich text and Source type the note's body draft, which the
	store saves after a pause and this view sends when it goes away. The rich-text view
	stays mounted while the note is open, a rename included, so its undo
	history survives saves; it starts over only when the note's text changes
	under it.
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
	import PinIcon from '@lucide/svelte/icons/pin';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { useDebounce } from 'runed';
	import { onDestroy } from 'svelte';
	import { folderLabel, type NoteFields, noteIdOf } from '$lib/data.js';
	import { foldersOf, type NoteListing, type Notes } from '$lib/notes.svelte.js';
	import { confirmDelete } from './file-actions.js';
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
	const note = createQuery(() => ({
		...notes.queries.notes.list.queryOptions(),
		select: (listing: NoteListing) => listing.find((entry) => entry.stem === stem),
	}));
	const folders = createQuery(() => ({
		...notes.queries.folders.list.queryOptions(),
		select: foldersOf,
	}));
	/** The note as the views read and edit it: its draft while one is held. */
	const body = $derived(notes.noteBody(path));
	/** Edits wait once the notes are closing, and while this file is renamed or deleted. */
	const locked = $derived(notes.isLocked(path));

	/** Which view of the note shows. Switching writes nothing and discards nothing. */
	let tab = $state<'rich' | 'source'>('rich');

	/** Say so when a change was refused. */
	function refusal(problem: string | undefined) {
		if (problem) toast.warning('That change was not made', { description: problem });
	}

	/** Set fields of the note as its file is now, at once. */
	const set = (fields: Partial<NoteFields>) => refusal(notes.patchNote(path, fields));

	// The view follows a rename, but while the parent replaces it the prop
	// already reads the next note: the last path this view showed is its own.
	// svelte-ignore state_referenced_locally
	let own = path;
	$effect.pre(() => {
		own = path;
	});

	const setNote = createMutation(() => notes.setNote);
	/** The title typed and not yet saved; `undefined` shows the file. */
	let title = $state<string>();
	function sendTitle() {
		if (title === undefined) return;
		const why = notes.refusalAt(own);
		const at = noteIdOf(own);
		if (why !== undefined || at === undefined) return refusal(why);
		const sent = title;
		setNote.mutate(
			{ stem: at, fields: { title: sent } },
			{
				onSuccess: () => {
					if (title === sent) title = undefined;
				},
			},
		);
	}
	const sendTitleLater = useDebounce(sendTitle, 1000);
	// runed's timer outlives the view, and so does the store's for the body;
	// send both now instead.
	onDestroy(() => {
		void sendTitleLater.runScheduledNow();
		void notes.saveBody(own);
	});

	/** Whether typing here did not save: the title, or the body. */
	const unsaved = $derived(
		notes.isUnsaved(path) || (title !== undefined && setNote.isError && !setNote.isPending),
	);
	function saveAgain() {
		sendTitle();
		notes.saveAgain(path);
	}

	/** Type the Source's text as the note's body, as the textarea reports it. */
	const typeBody = (value: string) => refusal(notes.editBody(path, value));

	async function report(action: string, problem: string | undefined) {
		if (problem) toast.error(`Could not ${action}`, { description: problem });
	}

	/** A folder's option value. No folder is the empty value, so a folder id never is. */
	const optionOf = (id: string | null) => (id === null ? '' : `folder:${id}`);
	const idOf = (option: string) => (option === '' ? null : option.slice('folder:'.length));
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Note">
	{#if note.data?.result.error === null}
		{@const row = body.row ?? note.data.result.data.row}
		{@const folderId = row.fields.folderId}
		{@const pinned = row.fields.pinned}
		{@const deleted = typeof row.fields.deletedAt === 'string'}
		<div class="flex items-center gap-2 border-b px-3 py-2">
			<Input
				class="flex-1 text-base font-medium"
				bind:value={
					() => title ?? row.fields.title,
					(typed) => {
						title = typed;
						void sendTitleLater();
					}
				}
				onblur={() => void sendTitleLater.runScheduledNow()}
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
					set({ folderId: idOf(event.currentTarget.value) });
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
				onclick={() => set({ pinned: !pinned })}
			>
				<PinIcon class={pinned ? 'fill-current' : ''} />
			</Button>
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
						bind:value={() => row.body, typeBody}
						onblur={() => void notes.saveBody(path)}
						disabled={locked}
						aria-label="Markdown source"
						spellcheck={false}
					/>
				</div>
			</Tabs.Content>
		</Tabs.Root>

		<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
			<span role="status" data-testid="write-status">
				{notes.isWriting(path) || setNote.isPending || (sendTitleLater.pending && title !== undefined)
					? 'Saving…'
					: unsaved
						? 'Not saved to'
						: 'Saved to'}
				<code class="font-mono">{path}</code>
			</span>
			{#if unsaved}
				<Button size="sm" variant="outline" disabled={locked} onclick={saveAgain}>
					Save again
				</Button>
			{/if}
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
				<Button variant="outline" size="sm" onclick={() => void note.refetch()}>Try again</Button>
			{/if}
		</Empty.Root>
	{:else if note.isSuccess}
		<Empty.Root class="flex-1">
			<Empty.Title>This note is no longer in the folder</Empty.Title>
			<Empty.Description>It was renamed or deleted, here or by another program.</Empty.Description>
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
