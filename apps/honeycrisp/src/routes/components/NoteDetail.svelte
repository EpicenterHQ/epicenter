<!--
	The note presentation of one open file. FileDetail keeps this mounted
	while the whole-file source shows, and owns the shared recovery controls.
	Folder autosaves accepted input after its pause. The rich-text view retains its undo history
	while its body is unchanged, including when only the header changes.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Loading } from '@epicenter/ui/loading';
	import { toast, toastOnError } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import * as Tabs from '@epicenter/ui/tabs';
	import PinIcon from '@lucide/svelte/icons/pin';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { FileEdit } from '@epicenter/svelte/edits';
	import { createQuery } from '@tanstack/svelte-query';
	import { folderLabel, type HoneycrispTables, type NoteFields, noteIdOf } from '$lib/data.js';
	import { foldersOf, type Notes } from '$lib/notes.svelte.js';
	import { noteBody } from '$lib/editor/rich-text.js';
	import RichEditor from './RichEditor.svelte';

	let {
		notes,
		path: shownPath,
		fileEdit,
	}: {
		notes: Notes;
		/** Fixed for this component's lifetime, including presentation changes. */
		path: string;
		fileEdit: FileEdit<HoneycrispTables['notes']>;
	} = $props();

	// The parent keys this view by its path. While the parent replaces it,
	// the prop already reads the next item, so this view keeps its own.
	// svelte-ignore state_referenced_locally
	const path = shownPath;
	const folders = createQuery(() => ({
		...notes.queries.rows('folders'),
		select: foldersOf,
	}));
	/** The note as the rich-text view reads and edits it, when it reads as one. */
	// svelte-ignore state_referenced_locally
	const sourceEdit = notes.folder.tables.notes.edit(noteIdOf(path) ?? '');
	const shownNote = $derived(fileEdit.content?.issues === null ? fileEdit.content : undefined);
	/** Edits wait once the notes are closing, and while this file is deleted. */
	const locked = $derived(notes.fenced);

	/** Which view of the note shows. Switching writes nothing and discards nothing. */
	let tab = $state<'rich' | 'source'>('rich');

	/** Say so when a change was refused. */
	function refusal(problem: string | undefined) {
		if (problem) toast.warning('That change was not made', { description: problem });
	}

	/** Set fields of the note and save at once. */
	const set = (fields: Partial<NoteFields>) => refusal(notes.patchNote(path, fields));

	/** A folder's option value. No folder is the empty value, so a folder id never is. */
	const optionOf = (id: string | null) => (id === null ? '' : `folder:${id}`);
	const idOf = (option: string) => (option === '' ? null : option.slice('folder:'.length));
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Note">
	{#if shownNote !== undefined}
		{@const row = shownNote}
		{@const folderId = row.fields.folderId}
		{@const pinned = row.fields.pinned}
		<div class="flex items-center gap-2 border-b px-3 py-2">
			<Input
				class="flex-1 text-base font-medium"
				bind:value={() => row.fields.title, (typed) => toastOnError(fileEdit.change({ fields: { title: typed.toWellFormed() } }), 'That change was not made')}
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
					fileEdit={sourceEdit}
					focusRequest={notes.focusRequest}
					closing={notes.fenced}
					onOpenSource={() => (tab = 'source')}
					onRefuse={(reason) => toast.warning('That edit was not made', { description: reason })}
				/>
			</Tabs.Content>
			<Tabs.Content value="source" class="flex min-h-0 flex-1 flex-col">
				<div class="flex min-h-0 flex-1 flex-col p-3">
					<Textarea
						class="min-h-40 flex-1 resize-none font-mono text-xs"
						bind:value={() => noteBody(row) ?? '', (typed) => toastOnError(fileEdit.change({ body: typed.toWellFormed() }), 'That change was not made')}
						disabled={locked}
						aria-label="Markdown source"
						spellcheck={false}
					/>
				</div>
			</Tabs.Content>
		</Tabs.Root>

	{:else if fileEdit.content?.issues}
		{@const issues = fileEdit.content.issues}
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
	{:else if fileEdit.loadError?.name === 'Missing'}
		<Empty.Root class="flex-1">
			<Empty.Title>This note is no longer in the folder</Empty.Title>
			<Empty.Description>It was deleted, here or in another tab.</Empty.Description>
		</Empty.Root>
	{:else if fileEdit.loadError}
		<Empty.Root class="flex-1">
			<Empty.Title>Could not read the note</Empty.Title>
			<Empty.Description>{fileEdit.loadError.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void fileEdit.refresh()}>Try again</Button>
		</Empty.Root>
	{:else}
		<Loading class="flex-1" label="Opening the note…" />
	{/if}
</section>
