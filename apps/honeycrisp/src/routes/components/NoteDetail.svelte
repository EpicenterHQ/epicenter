<!--
	The note presentation of one open file. FileDetail keeps this mounted
	while the whole-file source shows. The body draft retains typed input while
	its save runs. The rich-text view retains its undo history
	while its body is unchanged, including when only the header changes.
-->
<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { draft } from '@epicenter/svelte/folder-next';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import * as Tabs from '@epicenter/ui/tabs';
	import PinIcon from '@lucide/svelte/icons/pin';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { folderLabel, type NoteFields, noteIdOf } from '$lib/data.js';
	import { noteBody } from '$lib/editor/rich-text.js';
	import { foldersOf, type Notes } from '$lib/notes.svelte.js';
	import RichEditor from './RichEditor.svelte';

	let {
		notes,
		path: shownPath,
	}: {
		notes: Notes;
		/** Fixed for this component's lifetime, including presentation changes. */
		path: string;
	} = $props();

	// The parent keys this view by its path. While the parent replaces it,
	// the prop already reads the next item, so this view keeps its own.
	// svelte-ignore state_referenced_locally
	const path = shownPath;
	const id = noteIdOf(path) ?? '';
	// The notes state is fixed for the page's life.
	// svelte-ignore state_referenced_locally
	const table = notes.folder.tables.notes;
	// Reading the row holds the note's file while this view shows it.
	const row = $derived(table.row(id));
	const shownNote = $derived(row?.issues === null ? row : undefined);
	const title = draft(() => shownNote?.fields.title ?? '', (value) => table.update(id, { fields: { title: value } }));
	const body = draft(() => noteBody(shownNote) ?? '', (value) => table.update(id, { body: value }));
	const folderSelection = draft(() => shownNote?.fields.folderId ?? null, (value) => table.update(id, { fields: { folderId: value } }));
	const unreadable = $derived(row?.issues?.find((issue) => issue.kind === 'unreadable'));
	const folders = $derived(foldersOf(notes.folder.tables.folders.rows));

	/** Which view of the note shows. Switching writes nothing and discards nothing. */
	let tab = $state<'rich' | 'source'>('rich');

	/** Say so when a change was refused. */
	function refusal(problem: Awaited<ReturnType<Notes['patchNote']>>) {
		if (problem) toast.warning('That change was not made', { description: problem });
	}

	/** Set fields of the note and save at once. */
	const set = async (fields: Partial<NoteFields>) => refusal(await notes.patchNote(path, fields));

	/** A folder's option value. No folder is the empty value, so a folder id never is. */
	const optionOf = (id: string | null) => (id === null ? '' : `folder:${id}`);
	const idOf = (option: string) => (option === '' ? null : option.slice('folder:'.length));
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Note">
	{#if shownNote !== undefined}
		{@const row = shownNote}
		{@const folderId = folderSelection.value}
		{@const pinned = row.fields.pinned}
		<div class="flex items-center gap-2 border-b px-3 py-2">
			<Input
				class="flex-1 text-base font-medium"
				bind:value={() => title.value, (typed) => title.set(typed.toWellFormed())}

				placeholder="Title"
				aria-label="Title"
			/>
			<select
				class="h-9 max-w-40 rounded-md border bg-background px-2 text-sm"
				aria-label="Folder"
				value={optionOf(folderId)}

				onchange={(event) => folderSelection.set(idOf(event.currentTarget.value))}
			>
				<option value="">No folder</option>
				{#each folders as folder (folder.id)}
					<option value={optionOf(folder.id)}>{folderLabel(folder)}</option>
				{/each}
				{#if folderId !== null && !folders.some((folder) => folder.id === folderId)}
					<option value={optionOf(folderId)}>{folderId} (missing)</option>
				{/if}
			</select>
			<Button
				variant={pinned ? 'secondary' : 'ghost'}
				size="icon-sm"
				aria-label={pinned ? 'Unpin' : 'Pin'}
				aria-pressed={pinned}
				tooltip={pinned ? 'Unpin' : 'Pin'}

				onclick={() => set({ pinned: !row.fields.pinned })}
			>
				<PinIcon class={pinned ? 'fill-current' : ''} />
			</Button>
		</div>
		<UnsavedEdit draft={title} />
		<UnsavedEdit draft={folderSelection} />

		<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col">
			<Tabs.List class="mx-3">
				<Tabs.Trigger value="rich">Rich text</Tabs.Trigger>
				<Tabs.Trigger value="source">Source</Tabs.Trigger>
			</Tabs.List>
			<!-- The rich-text view stays mounted while Source shows, so its undo history
			     survives a look at the source that changes nothing. -->
			<Tabs.Content value="rich" forceMount class="min-h-0 flex-1">
				<RichEditor
					note={{ read: () => (shownNote ? body.value : undefined), write: body.set }}
					focusRequest={notes.focusRequest}
					onOpenSource={() => (tab = 'source')}
					onRefuse={(reason) => toast.warning('That edit was not made', { description: reason })}
				/>
			</Tabs.Content>
			<Tabs.Content value="source" class="flex min-h-0 flex-1 flex-col">
				<div class="flex min-h-0 flex-1 flex-col p-3">
					<Textarea
						class="min-h-40 flex-1 resize-none font-mono text-xs"
						bind:value={() => body.value, (typed) => body.set(typed.toWellFormed())}

						aria-label="Markdown source"
						spellcheck={false}
					/>
				</div>
			</Tabs.Content>
		</Tabs.Root>
		<UnsavedEdit draft={body} />

	{:else if row === undefined}
		<Empty.Root class="flex-1">
			<Empty.Title>This note is no longer in the folder</Empty.Title>
			<Empty.Description>It was deleted, here or in another tab.</Empty.Description>
		</Empty.Root>
	{:else if unreadable?.kind === 'unreadable'}
		<Empty.Root class="flex-1">
			<Empty.Title>Could not read the note</Empty.Title>
			<Empty.Description>{unreadable.error.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={() => void notes.folder.refresh()}>Try again</Button>
		</Empty.Root>
	{:else if row.issues !== null}
		{@const issues = row.issues}
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
				<Button variant="outline" size="sm" onclick={() => void notes.open(path, 'text')}>Repair as text</Button>
			{/if}
		</Empty.Root>
	{/if}
</section>
