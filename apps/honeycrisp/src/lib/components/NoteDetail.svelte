<!--
	The open note: its title and body as immediate editors (`fieldEdit`),
	its folder and pin as commands, and Delete. The body is CodeMirror over
	the Markdown text itself. A note at its path that does not read shows its
	text and why, to repair (`replace`) or delete.
-->
<script lang="ts">
	import { fieldEdit } from '@epicenter/svelte/client';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import PinIcon from '@lucide/svelte/icons/pin';
	import NoteEditor from '$lib/editor/NoteEditor.svelte';
	import { folderLabel, getHoneycrisp, noteLabel, notePath } from '$lib/honeycrisp.svelte.js';
	import { confirmDeleteNote } from './delete-note.js';
	import RepairDetail from './RepairDetail.svelte';

	const app = getHoneycrisp();
	const { notes, folders } = app;
	let { id: shownId }: { id: string } = $props();

	// The parent keys this view by the note.
	// svelte-ignore state_referenced_locally
	const id = shownId;
	const note = $derived(notes.get({ id }));
	const invalid = $derived(notes.invalid.find((file) => file.id === id));
	/** A note just made opens ready to write in. */
	const isNew = app.takeNew(id);
	const title = fieldEdit(notes, { id }, 'title');
	const body = fieldEdit(notes, { id }, 'body');

	/** A folder's option value. No folder is the empty value, so a folder id never is. */
	const optionOf = (folderId: string | undefined) => (folderId === undefined ? '' : `folder:${folderId}`);
	const folderOf = (option: string) => (option === '' ? undefined : option.slice('folder:'.length));

	async function set(action: string, patch: { folderId?: string; pinned?: boolean }) {
		const { error } = await notes.update({ id }, patch);
		if (error !== null) toast.error(`Could not ${action}`, { description: error.message });
	}
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Note">
	{#if title.error !== null || body.error !== null}
		<div class="space-y-2 px-3 py-2">
			<UnsavedEdit edit={title} />
			<UnsavedEdit edit={body} />
		</div>
	{/if}
	{#if note}
		{@const folderId = note.folderId}
		<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
			<Input
				class="min-w-40 flex-1 text-base font-medium"
				placeholder={noteLabel({ title: undefined, body: note.body })}
				aria-label="Title"
				bind:value={() => title.value ?? '', (value) => (title.value = value)}
			/>
			<select
				class="h-9 max-w-40 rounded-md border bg-background px-2 text-sm"
				aria-label="Folder"
				value={optionOf(folderId)}
				onchange={(event) => void set('move the note', { folderId: folderOf(event.currentTarget.value) })}
			>
				<option value="">No folder</option>
				{#each folders.items as folder (folder.id)}
					<option value={optionOf(folder.id)}>{folderLabel(folder)}</option>
				{/each}
				{#if folderId !== undefined && folders.get({ id: folderId }) === undefined}
					<option value={optionOf(folderId)}>A deleted folder</option>
				{/if}
			</select>
			<Button
				variant={note.pinned ? 'secondary' : 'ghost'}
				size="icon-sm"
				aria-label={note.pinned ? 'Unpin' : 'Pin'}
				aria-pressed={note.pinned ?? false}
				tooltip={note.pinned ? 'Unpin' : 'Pin'}
				onclick={() => void set('pin the note', { pinned: !note.pinned })}
			>
				<PinIcon class={note.pinned ? 'fill-current' : ''} />
			</Button>
		</div>
		<div class="min-h-0 flex-1">
			<NoteEditor body={body.value ?? ''} onEdit={(text) => (body.value = text)} autofocus={isNew} />
		</div>
		<div class="flex shrink-0 items-center gap-2 border-t px-4 py-2">
			<span class="min-w-0 truncate font-mono text-xs text-muted-foreground" data-testid="file-path">{notePath(id)}</span>
			<Button
				class="ml-auto"
				size="sm"
				variant="ghost-destructive"
				onclick={() => confirmDeleteNote(app, { id, label: noteLabel(note) })}
			>
				Delete
			</Button>
		</div>
	{:else if invalid}
		<RepairDetail
			file={invalid}
			kind="note"
			replace={(text, options) => notes.replace({ id }, text, options)}
			onDelete={() => confirmDeleteNote(app, { id, label: `${id}.md` })}
		/>
	{:else}
		<Empty.Root class="flex-1">
			<Empty.Title>This note is no longer here</Empty.Title>
			<Empty.Description>It was deleted, here or elsewhere.</Empty.Description>
		</Empty.Root>
	{/if}
</section>
