<!--
	One selected path and its presentations. A note or a folder has one
	editor (`openEditor`), opened here and given to every view of it: the
	note presentation edits its body and the source presentation its whole
	text, frontmatter included, as two views of one draft, so switching
	between them loses nothing. The note presentation stays mounted while the
	source shows, so its view keeps its undo history. The source is how a
	note or folder that does not read as one is repaired; any other file
	shows exactly as this device holds it.
-->
<script lang="ts">
	import { basename } from '@epicenter/folder/file-browser';
	import type { Editor } from '@epicenter/repository';
	import SourceEditor from '@epicenter/svelte/repository/source-editor';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileIcon from '@lucide/svelte/icons/file';
	import { onDestroy } from 'svelte';
	import { folderStemOf, honeycrispApp, noteStemOf } from '$lib/data.js';
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
	const noteStem = noteStemOf(path);
	const folderStem = folderStemOf(path);
	// The notes are fixed for the app's life.
	// svelte-ignore state_referenced_locally
	const { repo } = notes;

	const note = $derived(noteStem === undefined ? undefined : repo.notes.get({ stem: noteStem }));
	const folder = $derived(folderStem === undefined ? undefined : repo.folders.get({ stem: folderStem }));
	/** The note or folder this path is, as the page holds it. */
	const entry = $derived(note ?? folder);

	/** Any other file's text as this device holds it, read again after every change; undefined until read. */
	let other = $state.raw<string | null>();
	$effect(() => {
		if (noteStem !== undefined || folderStem !== undefined) return;
		repo.revision();
		let current = true;
		void repo.query<{ text: string }>('SELECT text FROM "epicenter/files" WHERE path = ? AND text IS NOT NULL', [path]).then((rows) => {
			if (current && rows.error === null) other = rows.data[0]?.text ?? null;
		});
		return () => {
			current = false;
		};
	});
	const text = $derived(entry?.text ?? other ?? undefined);
	const gone = $derived(noteStem !== undefined || folderStem !== undefined ? entry === undefined : other === null);

	/** The note's or folder's editor, once open; a note just created opens it once it is stored. */
	let editor = $state.raw<Editor>();
	let destroyed = false;
	const opening = noteStem !== undefined ? repo.notes.openEditor({ stem: noteStem }) : folderStem !== undefined ? repo.folders.openEditor({ stem: folderStem }) : undefined;
	void opening?.then((opened) => {
		if (opened.error !== null) return;
		if (destroyed) void opened.data.close();
		else editor = opened.data;
	});
	onDestroy(() => {
		destroyed = true;
		void editor?.close().then(({ error }) => {
			if (error !== null) toast.warning(`${name} is not saved yet`, { description: `${error.reason}. It is kept here and saved once it can be.` });
		});
	});
</script>

<div class="flex h-full min-h-0 flex-col">
	{#if noteStem !== undefined}
		<!-- Hidden and inert, rather than unmounted: the editor's history stays here. -->
		<div class="min-h-0 flex-1" hidden={as !== 'note'} inert={as !== 'note'}>
			<NoteDetail {notes} {path} {editor} />
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
				{#if note?.valid}
					<Button size="sm" variant="outline" onclick={() => notes.open(path, 'note')}>Open as note</Button>
				{/if}
				<Button variant="ghost" size="icon-sm" tooltip="Copy path" aria-label="Copy path" onclick={() => void copyPath(path)}>
					<CopyIcon />
				</Button>
			</div>

			{#if entry !== undefined && editor !== undefined}
				<SourceEditor
					{editor}
					check={(source) => honeycrispApp.check(source, { as: noteStem !== undefined ? 'notes' : 'folders' })}
					state={entry.state}
					label="Source of {name}"
					class="flex-1"
				/>
			{:else if text !== undefined && entry === undefined}
				<pre class="min-h-40 flex-1 overflow-auto px-4 py-3 font-mono text-xs break-words whitespace-pre-wrap" aria-label="Text of {name}">{text}</pre>
			{:else if gone}
				<Empty.Root class="flex-1">
					<Empty.Title>This file is no longer here</Empty.Title>
					<Empty.Description>It was deleted, here or on another device.</Empty.Description>
				</Empty.Root>
			{/if}
		</section>
	{/if}

	{#if text !== undefined}
		<div class="flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
			<span class="min-w-0 flex-1"></span>
			{#if as === 'note' && note?.valid}
				{#if typeof note.fields.deletedAt === 'string'}
					<Button size="sm" variant="outline" onclick={() => notes.restoreNote(path)}>Restore</Button>
					<Button size="sm" variant="ghost-destructive" onclick={() => confirmDelete(notes, path)}>Delete permanently</Button>
				{:else}
					<Button size="sm" variant="ghost-destructive" onclick={() => notes.trashNote(path)}>Move to Recently Deleted</Button>
				{/if}
			{:else if as === 'text' && notes.deletable(path)}
				<Button size="sm" variant="ghost-destructive" onclick={() => confirmDelete(notes, path)}>Delete</Button>
			{/if}
		</div>
	{/if}
</div>
