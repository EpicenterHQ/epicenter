<!--
	One selected path and its presentations.
	The note presentation stays mounted while whole-file source shows, so
	looking at source or editing only its header retains rich-text history.
	The folder mirror owns landed files; each editor owns its pending draft.
-->
<script lang="ts">
	import { InstantString } from '@epicenter/definition';
	import { basename } from '@epicenter/folder/file-browser';
	import { readRow } from '@epicenter/folder';
	import { fileEdit } from '@epicenter/svelte/folder';
	import RowIssues from '@epicenter/svelte/row-issues';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileIcon from '@lucide/svelte/icons/file';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { folderIdOf, honeycrispTables, noteIdOf } from '$lib/data.js';
	import { type Notes } from '$lib/notes.svelte.js';
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
	const name = basename(path);
	const noteId = noteIdOf(path);
	const folderId = folderIdOf(path);
	// The notes state is fixed for the page's life.
	// svelte-ignore state_referenced_locally
	const { folder } = notes;

	/** Text this large is listed but not opened in the editor. */
	const LARGE = 1024 * 1024;

	// Reading the file holds it while this view shows it.
	const file = $derived(folder.file(path));
	const noteRow = $derived(noteId === undefined ? undefined : folder.tables.notes.row(noteId));
	const note = $derived(noteRow?.issues === null ? noteRow : undefined);
	const text = $derived(typeof file?.data === 'string' && file.data.length <= LARGE ? file.data : undefined);
	const raw = fileEdit(folder, path);
	let switching = $state(false);
	/** Why the text does not read as its row, apart from the file's own state. */
	const issues = $derived(
		text === undefined || (noteId === undefined && folderId === undefined)
			? []
			: readRow(raw.value, noteId !== undefined ? honeycrispTables.notes : honeycrispTables.folders).issues ?? [],
	);
	const unreadable = $derived(file?.readError);

	async function report(action: string, result: ReturnType<Notes['patchNote']>) {
		const problem = await result;
		if (problem) toast.error(`Could not ${action}`, { description: problem });
	}

	export async function openAsNote() {
		if (switching || notes.selected?.path !== path) return;
		switching = true;
		const { error } = await raw.landed();
		if (error !== null || issues.length > 0 || notes.selected?.path !== path) {
			switching = false;
			return;
		}
		notes.open(path, 'note');
		switching = false;
	}

	/** A file shown as details: its extension names the type, then its size. */
	function details(size: number | undefined) {
		const dot = name.lastIndexOf('.');
		const kind = dot > 0 ? `${name.slice(dot + 1).toUpperCase()} file` : 'File';
		if (size === undefined) return kind;
		if (size < 1024) return `${kind} · ${size} ${size === 1 ? 'byte' : 'bytes'}`;
		if (size < 1024 * 1024) return `${kind} · ${(size / 1024).toFixed(1)} KB`;
		return `${kind} · ${(size / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<div class="flex h-full min-h-0 flex-col">
	{#if noteId !== undefined}
		<!-- Hidden and inert, rather than unmounted: this file's rich-text history stays here. -->
		<div class="min-h-0 flex-1" hidden={as !== 'note'} inert={as !== 'note'}>
			<NoteDetail {notes} {path} />
		</div>
	{/if}
	{#if as === 'text'}
		<section class="flex min-h-0 flex-1 flex-col" aria-label="File" inert={switching}>
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
						disabled={issues.length > 0}
						tooltip={issues.length > 0 ? 'Fix the text first' : undefined}
						onclick={openAsNote}
					>
						Open as note
					</Button>
				{/if}
				<Button variant="ghost" size="icon-sm" tooltip="Copy path" aria-label="Copy path" onclick={() => void copyPath(path)}>
					<CopyIcon />
				</Button>
			</div>

			{#if text !== undefined}
				{#if issues.length > 0}
					<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="row-issues">
						<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
							<Badge variant="destructive">Needs repair</Badge>
							This text does not read as a {noteId !== undefined ? 'note' : 'folder'} yet. Fix it here; it is checked as you type and saves automatically.
						</p>
						<div class="space-y-0.5 text-muted-foreground"><RowIssues {issues} /></div>
					</div>
				{/if}
				<div class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
					<Textarea
						class="min-h-40 flex-1 resize-none font-mono text-xs"
						aria-label="Contents of {name}"
						spellcheck={false}
						bind:value={raw.value}
					/>
				</div>
			{:else if file === undefined}
				<Empty.Root class="flex-1">
					<Empty.Title>This file is no longer in the folder</Empty.Title>
					<Empty.Description>It was deleted, here or in another tab.</Empty.Description>
				</Empty.Root>
			{:else if unreadable !== null && unreadable !== undefined}
				<Empty.Root class="flex-1">
					<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
					<Empty.Title>Could not open this file</Empty.Title>
					<Empty.Description>{unreadable.message}</Empty.Description>
					<Button variant="outline" size="sm" onclick={() => void folder.refresh()}>Try again</Button>
				</Empty.Root>
			{:else}
				<Empty.Root class="flex-1">
					<Empty.Media><FileIcon class="size-8 text-muted-foreground" /></Empty.Media>
					<Empty.Title>{details(file.data === undefined ? undefined : typeof file.data === 'string' ? new TextEncoder().encode(file.data).length : file.data.byteLength)}</Empty.Title>
					<Empty.Description>
						{typeof file.data === 'string'
							? 'This text file is larger than 1 MB, so it is not opened in the editor.'
							: 'This file is not text, so it is listed here but not opened for editing.'}
						Delete still works on it.
					</Empty.Description>
				</Empty.Root>
			{/if}
		</section>
	{/if}
	<UnsavedEdit edit={raw} />

	{#if file !== undefined}
		<div class="shrink-0 space-y-2 border-t px-4 py-2 text-xs text-muted-foreground">
			<div class="flex flex-wrap items-center gap-2">
				<span class="min-w-0 flex-1"></span>
				{#if as === 'note' && note !== undefined}
					{#if typeof note.fields.deletedAt === 'string'}
						<Button size="sm" variant="outline" onclick={() => report('restore the note', notes.patchNote(path, { deletedAt: null }))}>Restore</Button>
						<Button size="sm" variant="ghost-destructive" onclick={() => void confirmDelete(notes, path)}>Delete permanently</Button>
					{:else}
						<Button size="sm" variant="ghost-destructive" onclick={() => report('delete the note', notes.patchNote(path, { deletedAt: InstantString.now() }))}>Move to Recently Deleted</Button>
					{/if}
				{:else if as === 'text'}
					<Button size="sm" variant="ghost-destructive" onclick={() => void confirmDelete(notes, path)}>Delete</Button>
				{/if}
			</div>
		</div>
	{/if}
</div>
