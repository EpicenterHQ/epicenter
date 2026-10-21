<!--
	An open item other than a note: a file's exact text, or its type and size
	when it is not editable text. Typing is held as the file's text draft and
	saved a second after the last keystroke, when the person leaves the text,
	and when the view goes away, from the text it started from, merged by
	line with a change saved elsewhere. A note or folder file whose text does
	not read as a row shows its current issues, including unsaved input,
	and is repaired here; a note that reads opens as a note again.
-->
<script lang="ts">
	import { textRead } from '$lib/file-reads.js';

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
	import { unsavedText } from '@epicenter/svelte/write-failure';
	import { createRowEdit, createTextEdit } from '@epicenter/svelte/edits';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { folderIdOf, noteIdOf } from '$lib/data.js';
	import type { Notes } from '$lib/notes.svelte.js';
	import { describeFailure } from '$lib/status.js';
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
	onDestroy(() => void textEdit.save());

	/**
	 * What the file is: text, binary, or too large to open, with its size.
	 * Its reads, polled while the view shows, also keep the edit's file
	 * current, an edit made outside this page included.
	 */
	const file = createQuery(() => notes.queries.file(path, textRead));
	/** The folder's edit of the file: held text, else the file as stored. Keyed by its opening. */
	// svelte-ignore state_referenced_locally
	const textEdit = createTextEdit(notes.folder.files, path);
	const name = basename(path);
	const noteId = noteIdOf(path);
	const folderId = folderIdOf(path);
	// This view is keyed by its opening; only its address determines the adapter.
	// svelte-ignore state_referenced_locally
	const rowEdit = noteId !== undefined
		? createRowEdit(notes.folder.tables.notes, noteId)
		: folderId !== undefined ? createRowEdit(notes.folder.tables.folders, folderId) : undefined;
	/**
	 * The text shown: what was typed and not yet saved, else the file as
	 * stored, while the file reads as text. A file gone, no longer text, or
	 * too large shows as that, and is never read into the textEdit.
	 */
	const pending = $derived(textEdit.pending);
	const text = $derived(pending !== undefined || file.data?.kind === 'text' ? textEdit.text : undefined);
	/** Why the current text is not a row, including unsaved input. */
	const issues = $derived(rowEdit?.row?.issues ?? undefined);
	/** Edits wait once the notes are closing, and while this file is deleted. */
	const locked = $derived(notes.isLocked(path));
	/** A failed read with nothing of this file to show but what it held before. */
	const reading = $derived(pending === undefined && file.isError && file.data?.kind !== 'text');
	const failed = $derived(pending?.error === undefined ? undefined : describeFailure(pending.error));

	/** A file shown as details: its extension names the type, then its size. */
	function details(size: number) {
		const dot = name.lastIndexOf('.');
		const kind = dot > 0 ? `${name.slice(dot + 1).toUpperCase()} file` : 'File';
		if (size < 1024) return `${kind} · ${size} ${size === 1 ? 'byte' : 'bytes'}`;
		if (size < 1024 * 1024) return `${kind} · ${(size / 1024).toFixed(1)} KB`;
		return `${kind} · ${(size / (1024 * 1024)).toFixed(1)} MB`;
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

	{#if pending?.error !== undefined && (text === undefined || pending.kind !== 'text')}
		<div class="space-y-2 p-4" role="status">
			<p>These changes have not saved. If they cannot be applied to this file, copy them before discarding.</p>
			<pre class="max-h-40 overflow-auto whitespace-pre-wrap" aria-label="Unsaved note changes">{unsavedText(pending)}</pre>
			<Button disabled={locked} onclick={() => void textEdit.retry()}>Save again</Button>
			<Button variant="outline" disabled={locked} onclick={() => textEdit.discard()}>Discard changes</Button>
		</div>
	{/if}
	{#if text !== undefined}
		{@const shown = text}
		{#if file.isError}
			<p class="px-4 py-2 text-sm" role="alert">Could not read the saved file: {file.error.message} <Button variant="link" size="xs" onclick={() => void file.refetch()}>Try again</Button></p>
		{/if}
		{#if issues}
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
				readonly={reading}
				bind:value={
					() => shown.replace(/\r\n?/g, '\n'),
					(typed) => {
						const changed = textEdit.change(withFileNewlines(typed.toWellFormed(), shown));
						if (changed.error !== null) toast.warning('That change was not made', { description: changed.error.message });
					}
				}
				onblur={() => void textEdit.save()}
			/>
		</div>
		<p class="flex shrink-0 items-center gap-2 border-t px-4 py-1 text-xs text-muted-foreground" role="status" data-testid="write-status">
			{#if failed !== undefined && !notes.isWriting(path)}
				Not saved: {failed}
				<Button variant="link" size="xs" class="h-auto p-0" disabled={locked} onclick={() => void textEdit.retry()}>Save again</Button>
				<Button variant="link" size="xs" class="h-auto p-0" disabled={locked} onclick={() => textEdit.discard()}>Discard changes</Button>
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
