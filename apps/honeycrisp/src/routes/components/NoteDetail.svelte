<!--
	One open note: the folder's edit of its row, the same document the list's
	reads keep current, so it never disagrees with the list. Its title,
	folder, pin, and body are typed into that edit: what is typed shows at once
	and saves a second after the last change, at once when the person leaves
	the title or Source, picks a folder or a pin, and when the view goes
	away. Each save merges with whatever was saved meanwhile. The rich-text
	view stays mounted while the note is open, so its undo history survives
	saves; it starts over only when the note's text changes under it.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import * as Tabs from '@epicenter/ui/tabs';
	import PinIcon from '@lucide/svelte/icons/pin';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { InstantString } from '@epicenter/definition';
	import { unsavedText } from '@epicenter/svelte/write-failure';
	import { createFileEdit } from '@epicenter/svelte/edits';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { folderLabel, type NoteFields, noteIdOf } from '$lib/data.js';
	import { foldersOf, type Notes } from '$lib/notes.svelte.js';
	import { describeFailure } from '$lib/status.js';
	import { confirmDelete } from './file-actions.js';
	import { noteBody } from '$lib/editor/rich-text.js';
	import RichEditor from './RichEditor.svelte';

	let {
		notes,
		path: shownPath,
	}: {
		notes: Notes;
		/** The note shown. The parent keys this view by its opening. */
		path: string;
	} = $props();

	// The parent keys this view by its opening. While the parent replaces it,
	// the prop already reads the next item, so this view keeps its own.
	// svelte-ignore state_referenced_locally
	const path = shownPath;
	const id = noteIdOf(path) ?? '';
	const folders = createQuery(() => ({
		...notes.queries.rows('folders'),
		select: foldersOf,
	}));
	/**
	 * The folder's edit of the note: as stored, with what is typed over it.
	 * The note list beside this view reads the notes, which keeps it current.
	 */
	// svelte-ignore state_referenced_locally
	const coreEdit = notes.folder.tables.notes.edit(id);
	const fileEdit = createFileEdit(coreEdit);
	const status = $derived(fileEdit.readStatus);
	const pending = $derived(fileEdit.pending);
	/** The note as the rich-text view reads and edits it, when it reads as one. */
	const shownNote = $derived(fileEdit.markdown?.issues === null ? fileEdit.markdown : undefined);
	/** Edits wait once the notes are closing, and while this file is deleted. */
	const locked = $derived(fileEdit.locked);

	/** Which view of the note shows. Switching writes nothing and discards nothing. */
	let tab = $state<'rich' | 'source'>('rich');

	// The input outlives the view; send what is typed now.
	onDestroy(() => void fileEdit.save());

	/** Say so when a change was refused. */
	function refusal(problem: string | undefined) {
		if (problem) toast.warning('That change was not made', { description: problem });
	}

	/** Set fields of the note and save at once. */
	const set = (fields: Partial<NoteFields>) => refusal(notes.patchNote(path, fields));

	/** Whether typing here did not save, with no save running. */
	const unsaved = $derived(pending?.error !== undefined && !pending.saving);
	const writing = $derived(pending !== undefined && (pending.error === undefined || pending.saving));

	async function report(action: string, problem: string | undefined) {
		if (problem) toast.error(`Could not ${action}`, { description: problem });
	}

	function confirmDiscard() {
		confirmationDialog.open({
			title: 'Discard unsaved changes?',
			description: `Copy any text you need from ${path} before discarding it. What is saved stays on this device.`,
			confirm: { text: 'Discard changes', variant: 'destructive' },
			onConfirm: () => {
				fileEdit.discard();
			},
		});
	}

	/** A folder's option value. No folder is the empty value, so a folder id never is. */
	const optionOf = (id: string | null) => (id === null ? '' : `folder:${id}`);
	const idOf = (option: string) => (option === '' ? null : option.slice('folder:'.length));
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Note">
	{#if status.known === 'missing' && pending}
		<div class="w-full max-w-md text-left text-xs" role="status" data-testid="held-draft">
			<p>What you typed into it is not saved. Copy it, or save it again to put the deleted note back.</p>
			{#if pending.error}<p>Not saved: {describeFailure(pending.error)}</p>{/if}
			<pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap select-text" aria-label="Unsaved text">{unsavedText(pending)}</pre>
			<Button variant="outline" size="xs" disabled={locked} onclick={() => void fileEdit.save()}>Save it again</Button>
			<Button variant="ghost-destructive" size="xs" onclick={confirmDiscard}>Discard it</Button>
		</div>
	{/if}
	{#if shownNote !== undefined}
		{@const row = shownNote}
		{@const folderId = row.fields.folderId}
		{@const pinned = row.fields.pinned}
		{@const deleted = typeof row.fields.deletedAt === 'string'}
		<div class="flex items-center gap-2 border-b px-3 py-2">
			<Input
				class="flex-1 text-base font-medium"
				bind:value={() => row.fields.title, (typed) => refusal(fileEdit.change({ fields: { title: typed.toWellFormed() } }).error?.message)}
				onblur={() => void fileEdit.save()}
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
				{#each folders.data ?? [] as folder (folder.id)}
					<option value={optionOf(folder.id)}>{folderLabel(folder)}</option>
				{/each}
				{#if folderId !== null && !(folders.data ?? []).some((folder) => folder.id === folderId)}
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
					fileEdit={coreEdit}
					focusRequest={notes.focusRequest}
					onOpenSource={() => (tab = 'source')}
					onRefuse={(reason) => toast.warning('That edit was not made', { description: reason })}
				/>
			</Tabs.Content>
			<Tabs.Content value="source" class="flex min-h-0 flex-1 flex-col">
				<div class="flex min-h-0 flex-1 flex-col p-3">
					<Textarea
						class="min-h-40 flex-1 resize-none font-mono text-xs"
						bind:value={() => noteBody(row) ?? '', (typed) => refusal(fileEdit.change({ body: typed.toWellFormed() }).error?.message)}
						onblur={() => void fileEdit.save()}
						disabled={locked}
						aria-label="Markdown source"
						spellcheck={false}
					/>
				</div>
			</Tabs.Content>
		</Tabs.Root>

		<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
			<span role="status" data-testid="write-status">
				{#if unsaved && pending?.error}
					Not saved: {describeFailure(pending.error)}
				{:else}
					{writing ? 'Saving…' : 'Saved to'}
					<code class="font-mono">{path}</code>
				{/if}
			</span>
			{#if unsaved}
				<Button size="sm" variant="outline" disabled={locked} onclick={() => void fileEdit.save()}>
					Save again
				</Button>
			{/if}
			<Button
				size="sm"
				variant="ghost"
				tooltip="Edit the whole file as text, including keys Honeycrisp does not show"
				disabled={locked}
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
						onclick={() => void report('restore the note', notes.patchNote(path, { deletedAt: null }))}
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
						onclick={() => void report('delete the note', notes.patchNote(path, { deletedAt: InstantString.now() }))}
					>
						Move to Recently Deleted
					</Button>
				{/if}
			</div>
		</div>
	{:else if fileEdit.markdown?.issues}
		{@const issues = fileEdit.markdown.issues}
		<Empty.Root class="flex-1" data-testid="needs-repair">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			{#if issues.some((issue) => issue.kind === 'not-text')}
				<Empty.Title>This file is not text</Empty.Title>
				<Empty.Description>
					<code class="font-mono">{path}</code> cannot be opened here. Delete it from Files, or replace it with text.
				</Empty.Description>
			{:else}
				<Empty.Title><Badge variant="destructive">Needs repair</Badge> This file does not read as a note</Empty.Title>
				<Empty.Description>
					<code class="font-mono">{path}</code>: {issues.map((issue) => issue.message).join(' ')}
				</Empty.Description>
				<Button variant="outline" size="sm" onclick={() => notes.open(path, 'text')}>Repair as text</Button>
			{/if}
		</Empty.Root>
	{:else if status.known === 'missing'}
		<Empty.Root class="flex-1">
			<Empty.Title>This note is no longer in the folder</Empty.Title>
			<Empty.Description>It was deleted, here or in another tab.</Empty.Description>
		</Empty.Root>
	{:else if status.error}
		<Empty.Root class="flex-1">
			<Empty.Title>Could not read the note</Empty.Title>
			<Empty.Description>{status.error.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void fileEdit.read()}>Try again</Button>
		</Empty.Root>
	{:else}
		<Loading class="flex-1" label="Opening the note…" />
	{/if}
</section>
