<!--
	An open item other than a note: a file's exact text, or its type and size
	when it is not editable text. Typing is held as the file's text draft and
	saved at once over the version it started from, merged by line with a
	change made elsewhere. A note or folder file
	whose text is not a valid row shows its issues, read live from what is
	typed, and is repaired here; a note that reads opens as a note again.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { Textarea } from '@epicenter/ui/textarea';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileIcon from '@lucide/svelte/icons/file';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { parseRow, rowStemOf, wellFormed } from '@epicenter/folder';
	import { basename, dirname, withFileNewlines } from '@epicenter/folder/file-browser';
	import { createQuery } from '@tanstack/svelte-query';
	import { honeycrispDefinition, noteIdOf } from '$lib/data.js';
	import { describeError, type Notes } from '$lib/notes.svelte.js';
	import { confirmDelete, copyPath } from './file-actions.js';
	import FileNameBar from './FileNameBar.svelte';

	let {
		notes,
		path,
	}: {
		notes: Notes;
		/** The file shown. It follows a rename; the parent keys this view by its opening. */
		path: string;
	} = $props();

	const file = createQuery(() => notes.textQuery(path));
	const name = $derived(basename(path));
	const directory = $derived(dirname(path));
	const isNote = $derived(noteIdOf(path) !== undefined);
	/** The table a row file at this path belongs to, if any. */
	const table = $derived(
		isNote
			? honeycrispDefinition.tables.notes
			: rowStemOf('folders', path) !== undefined
				? honeycrispDefinition.tables.folders
				: undefined,
	);
	/** The text shown: what was typed and not yet written, else the file's. */
	const text = $derived(
		notes.typedText(path) ?? (file.data?.kind === 'text' ? file.data.file.text : undefined),
	);
	/** Why the text is not a row yet, read live from what is typed. */
	const issues = $derived.by(() => {
		if (table === undefined || text === undefined) return undefined;
		const { error } = parseRow(table, text);
		return error ?? undefined;
	});
	/** Edits wait once the notes are closing, and while this file is renamed or deleted. */
	const locked = $derived(notes.isLocked(path));

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
		{#if isNote && text !== undefined}
			<Button
				size="sm"
				variant="outline"
				disabled={issues !== undefined}
				tooltip={issues === undefined ? undefined : 'Fix the text first'}
				onclick={() => notes.open(path, 'note')}
			>
				Open as note
			</Button>
		{/if}
		<Button variant="ghost" size="icon-sm" tooltip="Copy path" aria-label="Copy path" onclick={() => void copyPath(path)}>
			<CopyIcon />
		</Button>
	</div>

	{#if file.data?.kind === 'text'}
		{@const shown = text ?? file.data.file.text}
		{#if issues}
			<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="row-issues">
				<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					This text does not read as a {isNote ? 'note' : 'folder'} yet. Fix it here; it saves as you type.
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
						notes.editText(path, withFileNewlines(wellFormed(typed), shown));
					}
				}
			/>
		</div>
		<p class="shrink-0 border-t px-4 py-1 text-xs text-muted-foreground" role="status" data-testid="write-status">
			{notes.isWriting(path) ? 'Saving…' : 'Saved'}
		</p>
	{:else if file.data !== undefined}
		<Empty.Root class="flex-1">
			<Empty.Media><FileIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>{details(file.data.size)}</Empty.Title>
			<Empty.Description>
				{file.data.kind === 'binary'
					? 'This file is not text, so it is listed here but not opened for editing.'
					: 'This text file is larger than 1 MB, so it is not opened in the editor.'}
				Rename and delete still work on it.
			</Empty.Description>
		</Empty.Root>
	{:else if file.isError}
		<Empty.Root class="flex-1">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Could not open this file</Empty.Title>
			<Empty.Description>{describeError(file.error)}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void file.refetch()}>Try again</Button>
		</Empty.Root>
	{:else}
		<Loading class="flex-1" label="Opening {name}…" />
	{/if}

	<FileNameBar
		prefix={directory === '' ? '' : `${directory}/`}
		{name}
		onRename={(next) => notes.rename(path, next)}
		onDelete={() => void confirmDelete(notes, path)}
	/>
</section>
