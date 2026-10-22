<!--
	One selected path, its presentations, and one save/recovery surface.
	The note presentation stays mounted while whole-file source shows, so
	looking at source or editing only its header retains rich-text history.
	Folder owns the input, autosave timer, and save queue. Blurring an input
	or leaving this view keeps that work with Folder. Retry is explicit here.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileIcon from '@lucide/svelte/icons/file';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { InstantString } from '@epicenter/definition';
	import { basename, withFileNewlines } from '@epicenter/folder/file-browser';
	import { createFileEdit } from '@epicenter/svelte/edits';
	import { createQuery } from '@tanstack/svelte-query';
	import { folderIdOf, noteIdOf } from '$lib/data.js';
	import { textRead } from '$lib/file-reads.js';
	import type { Notes } from '$lib/notes.svelte.js';
	import { describeFailure } from '$lib/status.js';
	import { confirmDelete, copyPath } from './file-actions.js';
	import NoteDetail from './NoteDetail.svelte';

	let {
		notes,
		path: shownPath,
		as,
	}: {
		notes: Notes;
		/** Fixed until another path is selected. */
		path: string;
		as: 'note' | 'text';
	} = $props();

	// The parent keys this view by its path. While the parent replaces it,
	// the prop already reads the next item, so this view keeps its own.
	// svelte-ignore state_referenced_locally
	const path = shownPath;

	/**
	 * What the file is: text, binary, or too large to open, with its size.
	 * Only the whole-file presentation needs this classification. The note
	 * list and FileEdit keep the source current in either presentation.
	 */
	const file = createQuery(() => ({
		...notes.queries.file(path, textRead),
		enabled: as === 'text',
	}));
	const name = basename(path);
	const noteId = noteIdOf(path);
	const folderId = folderIdOf(path);
	// All presentations use the same schema-bound adapter for this path.
	// svelte-ignore state_referenced_locally
	const noteEdit = noteId === undefined
		? undefined
		: createFileEdit(notes.folder.tables.notes.edit(noteId));
	// svelte-ignore state_referenced_locally
	const sourceEdit = folderId !== undefined
		? notes.folder.tables.folders.edit(folderId)
		: notes.folder.files.edit(path);
	// Both handles are fixed for this keyed view; the adapter memoizes acquisition.
	// svelte-ignore state_referenced_locally
	const fileEdit = noteEdit ?? (folderId !== undefined
		? createFileEdit(notes.folder.tables.folders.edit(folderId))
		: createFileEdit(notes.folder.files.edit(path)));
	const note = $derived(
		noteEdit?.content?.issues === null ? noteEdit.content : undefined,
	);
	// Classification limits an arbitrary file's initial acquisition only.
	// Pure cached access keeps already acquired text visible on every refresh.
	const content = $derived(
		noteEdit !== undefined || file.data?.kind === 'text' || sourceEdit.getSnapshot().content !== undefined
			? fileEdit.content : undefined,
	);
	const text = $derived(content?.text);
	const issues = $derived(content?.issues ?? undefined);
	const locked = $derived(notes.fenced);

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

	function report(action: string, problem: string | undefined) {
		if (problem) toast.error(`Could not ${action}`, { description: problem });
	}

	/** A file shown as details: its extension names the type, then its size. */
	function details(size: number) {
		const dot = name.lastIndexOf('.');
		const kind = dot > 0 ? `${name.slice(dot + 1).toUpperCase()} file` : 'File';
		if (size < 1024) return `${kind} · ${size} ${size === 1 ? 'byte' : 'bytes'}`;
		if (size < 1024 * 1024) return `${kind} · ${(size / 1024).toFixed(1)} KB`;
		return `${kind} · ${(size / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	{#if noteEdit !== undefined}
		<!-- Hidden and inert, rather than unmounted: this file's rich-text history stays here. -->
		<div class="min-h-0 flex-1" hidden={as !== 'note'} inert={as !== 'note'}>
			<NoteDetail {notes} {path} fileEdit={noteEdit} />
		</div>
	{/if}
	{#if as === 'text'}
		<section class="flex min-h-0 flex-1 flex-col" aria-label="File">
			<div class="flex items-center gap-2 border-b px-3 py-3 sm:px-4">
				<FileIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				<div class="min-w-0 flex-1">
					<h2 class="truncate text-sm font-medium">{name}</h2>
					<p class="truncate font-mono text-xs text-muted-foreground">{path}</p>
				</div>
				{#if noteId !== undefined && text !== undefined}
					<Button
						size="sm"
						variant="outline"
						disabled={issues !== undefined}
						tooltip={issues !== undefined ? 'Fix the text first' : undefined}
						onclick={() => notes.open(path, 'note')}
					>
						Open as note
					</Button>
				{/if}
				<Button variant="ghost" size="icon-sm" tooltip="Copy path" aria-label="Copy path" onclick={() => void copyPath(path)}>
					<CopyIcon />
				</Button>
			</div>

			{#if text !== undefined}
				{@const shown = text}
				{#if file.isError}
					<p class="px-4 py-2 text-sm" role="alert">Could not read the saved file: {file.error.message} <Button variant="link" size="xs" onclick={() => void file.refetch()}>Try again</Button></p>
				{/if}
				{#if issues && (noteId !== undefined || folderId !== undefined)}
					<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="row-issues">
						<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
							<Badge variant="destructive">Needs repair</Badge>
							This text does not read as a {noteId !== undefined ? 'note' : 'folder'} yet. Fix it here; it is checked as you type and saves when you pause.
						</p>
						<ul class="space-y-0.5 text-muted-foreground">
							{#each issues as issue, index (index)}
								<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
							{/each}
						</ul>
					</div>
				{/if}
				<div class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
					<Textarea
						class="min-h-40 flex-1 resize-none font-mono text-xs"
						aria-label="Contents of {name}"
						spellcheck={false}
						disabled={locked}
						bind:value={
							() => shown.replace(/\r\n?/g, '\n'),
							(typed) => {
								const changed = fileEdit.replaceText(withFileNewlines(typed.toWellFormed(), shown));
								if (changed.error !== null) toast.warning('That change was not made', { description: changed.error.message });
							}
						}
					/>
				</div>
			{:else if file.data?.kind === 'missing'}
				<Empty.Root class="flex-1">
					<Empty.Title>This file is no longer in the folder</Empty.Title>
					<Empty.Description>It was deleted, here or in another tab.</Empty.Description>
				</Empty.Root>
			{:else if file.data !== undefined && file.data.kind !== 'text'}
				<Empty.Root class="flex-1">
					<Empty.Media><FileIcon class="size-8 text-muted-foreground" /></Empty.Media>
					<Empty.Title>{details(file.data.size)}</Empty.Title>
					<Empty.Description>
						{file.data.kind === 'binary'
							? 'This file is not text, so it is listed here but not opened for editing.'
							: 'This text file is larger than 1 MB, so it is not opened in the editor.'}
						Delete still works on it.
					</Empty.Description>
				</Empty.Root>
			{:else if file.isError}
				<Empty.Root class="flex-1">
					<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
					<Empty.Title>Could not open this file</Empty.Title>
					<Empty.Description>{file.error.message}</Empty.Description>
					<Button variant="outline" size="sm" onclick={() => void file.refetch()}>Try again</Button>
				</Empty.Root>
			{:else}
				<Loading class="flex-1" label="Opening {name}…" />
			{/if}

		</section>
	{/if}

	{#if content !== undefined || note !== undefined}
		<div class="shrink-0 space-y-2 border-t px-4 py-2 text-xs text-muted-foreground">
			{#if fileEdit.loadError}<p role="alert">{fileEdit.loadError.message} Your previous text is kept.</p>{/if}
			{#if fileEdit.isDirty && fileEdit.loadError && content !== undefined}
				<details><summary>Your source</summary><pre class="max-h-40 overflow-auto whitespace-pre-wrap select-text" aria-label="Unsaved source">{content.text}</pre></details>
			{/if}
			<div class="flex flex-wrap items-center gap-2">
				<span class="min-w-0 flex-1" role="status" data-testid="write-status">
					{#if fileEdit.saveError}
						Not saved: {describeFailure(fileEdit.saveError)}
					{:else if fileEdit.isDirty || fileEdit.isSaving}
						Saving…
					{:else if fileEdit.loadError}
						Text kept here
					{:else if content === undefined}
						No unsaved changes
					{:else if as === 'note'}
						Saved to <code class="font-mono">{path}</code>
					{:else}
						Saved
					{/if}
				</span>
				{#if fileEdit.loadError}
					<Button size="sm" variant="outline" disabled={locked} onclick={() => void fileEdit.refresh()}>Try again</Button>
					{#if fileEdit.saveError === undefined && (fileEdit.loadError.name === 'Missing' || fileEdit.loadError.name === 'NotText')}
						<Button size="sm" variant="outline" disabled={locked} onclick={() => void fileEdit.save()}>Restore text</Button>
					{/if}
				{/if}
				{#if fileEdit.saveError}
					<Button size="sm" variant="outline" disabled={locked} onclick={() => void fileEdit.save()}>Save again</Button>
				{/if}
				{#if fileEdit.isDirty && (fileEdit.saveError || fileEdit.loadError)}
					<Button size="sm" variant="ghost-destructive" disabled={locked} onclick={confirmDiscard}>Discard changes</Button>
				{/if}
				{#if as === 'note' && note !== undefined}
					<Button size="sm" variant="ghost" tooltip="Edit the whole file as text, including keys Honeycrisp does not show" disabled={locked} onclick={() => notes.open(path, 'text')}>Edit as file</Button>
					{#if typeof note.fields.deletedAt === 'string'}
						<Button size="sm" variant="outline" disabled={locked} onclick={() => report('restore the note', notes.patchNote(path, { deletedAt: null }))}>Restore</Button>
						<Button size="sm" variant="ghost-destructive" disabled={locked} onclick={() => void confirmDelete(notes, path)}>Delete permanently</Button>
					{:else}
						<Button size="sm" variant="ghost-destructive" disabled={locked} onclick={() => report('delete the note', notes.patchNote(path, { deletedAt: InstantString.now() }))}>Move to Recently Deleted</Button>
					{/if}
				{:else if as === 'text' && (content !== undefined || (file.data !== undefined && file.data.kind !== 'missing'))}
					<Button size="sm" variant="ghost-destructive" disabled={locked} onclick={() => void confirmDelete(notes, path)}>Delete</Button>
				{/if}
			</div>
		</div>
	{:else if as === 'text' && file.data !== undefined && file.data.kind !== 'missing'}
		<div class="shrink-0 border-t px-4 py-2">
			<Button size="sm" variant="ghost-destructive" disabled={notes.fenced} onclick={() => void confirmDelete(notes, path)}>Delete</Button>
		</div>
	{/if}
</div>
