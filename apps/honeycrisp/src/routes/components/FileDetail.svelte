<!--
	One selected path and its presentations. The note presentation stays
	mounted while the file's text shows, so its editor keeps its undo
	history. The text presentation shows the file exactly as this device
	holds it; Honeycrisp writes a note only through its fields and body.
-->
<script lang="ts">
	import { basename } from '@epicenter/folder/file-browser';
	import { live } from '@epicenter/repository/svelte';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileIcon from '@lucide/svelte/icons/file';
	import { noteStemOf } from '$lib/data.js';
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

	// svelte-ignore state_referenced_locally
	const file = live(notes.repo.live<{ text: string }>('SELECT text FROM "epicenter/files" WHERE path = ? AND text IS NOT NULL', [path]));
	const text = $derived(file.current?.[0]?.text);
	const note = $derived(notes.noteFiles?.find((item) => item.path === path));
</script>

<div class="flex h-full min-h-0 flex-col">
	{#if noteStem !== undefined}
		<!-- Hidden and inert, rather than unmounted: the editor's history stays here. -->
		<div class="min-h-0 flex-1" hidden={as !== 'note'} inert={as !== 'note'}>
			<NoteDetail {notes} {path} />
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

			{#if note !== undefined && !note.valid}
				<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="row-issues">
					<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
						<Badge variant="destructive">Needs repair</Badge>
						This file does not read as a note. Honeycrisp keeps its text as it is.
					</p>
					<ul class="space-y-0.5 text-muted-foreground">
						{#each note.issues as issue}
							<li>{issue}</li>
						{/each}
					</ul>
				</div>
			{/if}
			{#if text !== undefined}
				<pre class="min-h-40 flex-1 overflow-auto px-4 py-3 font-mono text-xs break-words whitespace-pre-wrap" aria-label="Text of {name}">{text}</pre>
			{:else if file.current !== undefined}
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
