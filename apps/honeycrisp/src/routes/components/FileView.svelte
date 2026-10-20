<!--
	An open item other than a note: a file's exact text, or its type and size
	when it is not editable text. Typing is held as the file's text draft and
	saved a second after the last keystroke, when the person leaves the text,
	and when the view goes away, from the text it started from, merged by
	line with a change saved elsewhere. A note or folder file whose text does
	not read as a row shows its issues as the folder read it after its last
	save, and is repaired here; a note that reads opens as a note again.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileIcon from '@lucide/svelte/icons/file';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { basename, withFileNewlines } from '@epicenter/folder/file-browser';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { FOLDERS, type FolderRow, folderIdOf, NOTES, type NoteRow, noteIdOf } from '$lib/data.js';
	import type { Notes } from '$lib/notes.svelte.js';
	import { confirmDelete, copyPath } from './file-actions.js';

	let {
		notes,
		path: shownPath,
	}: {
		notes: Notes;
		/** The file shown. The parent keys this view by its opening. */
		path: string;
	} = $props();

	// The parent keys this view by its opening. While the parent replaces it,
	// the prop already reads the next item, so this view keeps its own.
	// svelte-ignore state_referenced_locally
	const path = shownPath;
	onDestroy(() => void notes.saveText(path));

	const file = createQuery(() => notes.textQuery(path));
	const name = basename(path);
	const noteId = noteIdOf(path);
	const folderId = folderIdOf(path);
	/** The row this file is, as its table last read it, when it is a note or folder file. */
	const note = createQuery(() => ({
		...notes.rowsQuery(NOTES),
		enabled: noteId !== undefined,
		select: (rows: NoteRow[]) => rows.find((row) => row.id === noteId),
	}));
	const folder = createQuery(() => ({
		...notes.rowsQuery(FOLDERS),
		enabled: folderId !== undefined,
		select: (rows: FolderRow[]) => rows.find((row) => row.id === folderId),
	}));
	/** The text shown: what was typed and not yet saved, else the file's. */
	const text = $derived(
		notes.typedText(path) ?? (file.data?.kind === 'text' ? file.data.text : undefined),
	);
	/** Why the saved text is not a row, as the folder read it after its last save. */
	const issues = $derived((note.data ?? folder.data)?.issues ?? undefined);
	const typing = $derived(notes.typedText(path) !== undefined);
	/** Edits wait once the notes are closing, and while this file is deleted. */
	const locked = $derived(notes.isLocked(path));
	const failed = $derived(notes.textError(path));

	/** A file shown as details: its extension names the type, then its size. */
	function details(size: number) {
		const dot = name.lastIndexOf('.');
		const kind = dot > 0 ? `${name.slice(dot + 1).toUpperCase()} file` : 'File';
		if (size < 1024) return `${kind} · ${size} ${size === 1 ? 'byte' : 'bytes'}`;
		if (size < 1024 * 1024) return `${kind} · ${(size / 1024).toFixed(1)} KB`;
		return `${kind} · ${(size / (1024 * 1024)).toFixed(1)} MB`;
	}

	/** Save the text typed, then show the note it now is. */
	async function openAsNote() {
		await notes.saveText(path);
		if (notes.textError(path) !== undefined) {
			toast.warning('The text is not saved yet', { description: notes.textError(path) });
			return;
		}
		notes.open(path, 'note');
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="File">
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
				disabled={issues !== undefined && !typing}
				tooltip={issues !== undefined && !typing ? 'Fix the text first' : undefined}
				onclick={() => void openAsNote()}
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
		{#if issues}
			<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="row-issues">
				<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					This text does not read as a {noteId !== undefined ? 'note' : 'folder'} yet. Fix it here; it saves as you type, and these are checked again after each save.
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
						notes.editText(path, withFileNewlines(typed.toWellFormed(), shown));
					}
				}
				onblur={() => void notes.saveText(path)}
			/>
		</div>
		<p class="flex shrink-0 items-center gap-2 border-t px-4 py-1 text-xs text-muted-foreground" role="status" data-testid="write-status">
			{#if failed !== undefined && !notes.isWriting(path)}
				Not saved: {failed}
				<Button variant="link" size="xs" class="h-auto p-0" disabled={locked} onclick={() => void notes.saveText(path)}>Save again</Button>
			{:else}
				{notes.isWriting(path) ? 'Saving…' : 'Saved'}
			{/if}
		</p>
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

	{#if file.data !== undefined && file.data.kind !== 'missing'}
		<div class="flex shrink-0 items-center gap-2 border-t px-4 py-2">
			<span class="min-w-0 truncate font-mono text-xs text-muted-foreground">{path}</span>
			<Button class="ml-auto" size="sm" variant="ghost-destructive" disabled={locked} onclick={() => void confirmDelete(notes, path)}>
				Delete
			</Button>
		</div>
	{/if}
</section>
