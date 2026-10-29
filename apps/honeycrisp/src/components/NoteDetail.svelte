<!--
	The note presentation of one open file. Its fields are controls that set
	them on the note (`patch`), so the rest of the note stays as it is; its
	body is a view of the note's editor, which FileDetail opens and shares
	with the source. FileDetail keeps this mounted while the file's text
	shows.
-->
<script lang="ts">
	import type { Editor } from '@epicenter/repository';
	import EditorStatus from '@epicenter/svelte/repository/editor-status';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import PinIcon from '@lucide/svelte/icons/pin';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { folderLabel, noteStemOf } from '../data.js';
	import NoteEditor from '../editor/NoteEditor.svelte';
	import { foldersOf, type Notes } from '../notes.svelte.js';

	let {
		notes,
		path: shownPath,
		editor,
		unopened,
	}: {
		notes: Notes;
		/** Fixed for this component's lifetime, including presentation changes. */
		path: string;
		/** The note's editor, once FileDetail has opened it. */
		editor: Editor | undefined;
		/** Why the editor did not open, and how to try again. */
		unopened?: { reason: string; retry(): void };
	} = $props();

	// The parent keys this view by its path. While the parent replaces it,
	// the prop already reads the next item, so this view keeps its own.
	// svelte-ignore state_referenced_locally
	const path = shownPath;
	const stem = noteStemOf(path) ?? '';

	const shown = $derived(notes.repo.notes.get({ stem }));
	const folders = $derived(foldersOf(notes.folderFiles));

	/** A folder's option value. No folder is the empty value, so a folder id never is. */
	const optionOf = (id: string | null) => (id === null ? '' : `folder:${id}`);
	const idOf = (option: string) => (option === '' ? null : option.slice('folder:'.length));
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Note">
	{#if shown?.valid}
			{@const folderId = shown.fields.folderId}
			{@const pinned = shown.fields.pinned}
			<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
				<Input
					class="min-w-40 flex-1 text-base font-medium"
					bind:value={() => shown.fields.title, (title) => notes.patchNote(path, { title }, 'Could not save the title')}
					placeholder="Title"
					aria-label="Title"
				/>
				<select
					class="h-9 max-w-40 rounded-md border bg-background px-2 text-sm"
					aria-label="Folder"
					value={optionOf(folderId)}
					onchange={(event) => notes.patchNote(path, { folderId: idOf(event.currentTarget.value) }, 'Could not move the note')}
				>
					<option value="">No folder</option>
					{#each folders as folder (folder.path)}
						<option value={optionOf(folder.params.stem)}>{folderLabel(folder)}</option>
					{/each}
					{#if folderId !== null && !folders.some((folder) => folder.params.stem === folderId)}
						<option value={optionOf(folderId)}>{folderId} (missing)</option>
					{/if}
				</select>
				<Button
					variant={pinned ? 'secondary' : 'ghost'}
					size="icon-sm"
					aria-label={pinned ? 'Unpin' : 'Pin'}
					aria-pressed={pinned}
					tooltip={pinned ? 'Unpin' : 'Pin'}
					onclick={() => notes.patchNote(path, { pinned: !pinned }, 'Could not pin the note')}
				>
					<PinIcon class={pinned ? 'fill-current' : ''} />
				</Button>
				<Button size="sm" variant="ghost" tooltip="Edit the whole file, including keys Honeycrisp does not show" onclick={() => notes.open(path, 'text')}>Edit source</Button>
			</div>

			{#if editor !== undefined}
				<NoteEditor {editor} focusRequest={notes.focusRequest} class="flex-1" />
				<EditorStatus {editor} state={shown.state} shows="body" />
			{:else if unopened !== undefined}
				{@const { reason, retry } = unopened}
				<p class="flex flex-wrap items-center gap-2 px-4 py-3 text-sm text-destructive" role="alert">
					{reason}
					<Button size="sm" variant="outline" onclick={retry}>Try again</Button>
				</p>
			{/if}
		{:else if shown === undefined}
			<Empty.Root class="flex-1">
				<Empty.Title>This note is no longer here</Empty.Title>
				<Empty.Description>It was deleted, here or on another device.</Empty.Description>
			</Empty.Root>
		{:else if shown}
			<Empty.Root class="flex-1" data-testid="needs-repair">
				<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
				<Empty.Title><Badge variant="destructive">Needs repair</Badge> This file does not read as a note</Empty.Title>
				<Empty.Description>
					<code class="font-mono">{path}</code>: {shown.issues.join('; ')}
				</Empty.Description>
				<Button variant="outline" size="sm" onclick={() => notes.open(path, 'text')}>Edit source</Button>
			</Empty.Root>
		{/if}
</section>
