<!--
	The open note as one immediate editor (`notes.edit`): its title, body,
	folder and pin, and Delete. The body is CodeMirror over the Markdown text
	itself. A note at its path that does not read shows its text and why, to
	repair (`replace`) or delete.
-->
<script lang="ts">
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import PinIcon from '@lucide/svelte/icons/pin';
	import NoteEditor from '$lib/editor/NoteEditor.svelte';
	import { byName, folderLabel, getFolders, getHoneycrisp, getNotes, noteLabel, notePath } from '$lib/honeycrisp.svelte.js';
	import { confirmDeleteNote } from './delete-note.js';
	import RepairDetail from './RepairDetail.svelte';

	const app = getHoneycrisp();
	const notes = getNotes();
	const folders = getFolders();
	let { id: shownId }: { id: string } = $props();

	// The parent keys this view by the note.
	// svelte-ignore state_referenced_locally
	const id = shownId;
	const invalid = $derived(notes.invalid().find((file) => file.id === id));
	/** A note just made opens ready to write in. */
	const isNew = app.takeNew(id);
	const edit = notes.edit({ id });

	/** A folder's option value. No folder is the empty value, so a folder id never is. */
	const optionOf = (folderId: string | undefined) => (folderId === undefined ? '' : `folder:${folderId}`);
	const folderOf = (option: string) => (option === '' ? undefined : option.slice('folder:'.length));
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Note">
	{#if edit.error() !== null}
		<div class="px-3 py-2">
			<UnsavedEdit {edit} />
		</div>
	{/if}
	{#if edit.exists()}
		{@const folderId = edit.fields.folderId}
		<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
			<Input
				class="min-w-40 flex-1 text-base font-medium"
				placeholder={noteLabel({ title: undefined, body: edit.fields.body ?? '' })}
				aria-label="Title"
				bind:value={edit.fields.title}
			/>
			<select
				class="h-9 max-w-40 rounded-md border bg-background px-2 text-sm"
				aria-label="Folder"
				bind:value={() => optionOf(folderId), (option) => (edit.fields.folderId = folderOf(option))}
			>
				<option value="">No folder</option>
				{#each folders.items().toSorted(byName) as folder (folder.id)}
					<option value={optionOf(folder.id)}>{folderLabel(folder)}</option>
				{/each}
				{#if folderId !== undefined && folders.get({ id: folderId }) === undefined}
					<option value={optionOf(folderId)}>A deleted folder</option>
				{/if}
			</select>
			<Button
				variant={edit.fields.pinned ? 'secondary' : 'ghost'}
				size="icon-sm"
				aria-label={edit.fields.pinned ? 'Unpin' : 'Pin'}
				aria-pressed={edit.fields.pinned ?? false}
				tooltip={edit.fields.pinned ? 'Unpin' : 'Pin'}
				onclick={() => (edit.fields.pinned = !edit.fields.pinned)}
			>
				<PinIcon class={edit.fields.pinned ? 'fill-current' : ''} />
			</Button>
		</div>
		<div class="min-h-0 flex-1">
			<NoteEditor body={edit.fields.body ?? ''} onEdit={(text) => (edit.fields.body = text)} autofocus={isNew} />
		</div>
		<div class="flex shrink-0 items-center gap-2 border-t px-4 py-2">
			<span class="min-w-0 truncate font-mono text-xs text-muted-foreground" data-testid="file-path">{notePath(id)}</span>
			<Button
				class="ml-auto"
				size="sm"
				variant="ghost-destructive"
				onclick={() => confirmDeleteNote(app, { id, label: noteLabel({ title: edit.fields.title, body: edit.fields.body ?? '' }) })}
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
