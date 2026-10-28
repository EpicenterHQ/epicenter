<!--
	The note presentation of one open file. The note is held open in the
	repository: its controls read it synchronously and write through it, so
	what a person types shows at once and changes from elsewhere arrive while
	it is open. FileDetail keeps this mounted while the file's text shows.
-->
<script lang="ts">
	import { opened } from '@epicenter/repository/svelte';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Textarea } from '@epicenter/ui/textarea';
	import * as Tabs from '@epicenter/ui/tabs';
	import { toast } from '@epicenter/ui/sonner';
	import PinIcon from '@lucide/svelte/icons/pin';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy } from 'svelte';
	import { folderLabel, noteStemOf } from '$lib/data.js';
	import { foldersOf, type Notes, report } from '$lib/notes.svelte.js';
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
	const stem = noteStemOf(path) ?? '';

	// Closed as this view goes, so the note never calls back into it afterward.
	let held: { close(): void } | undefined;
	let destroyed = false;
	// svelte-ignore state_referenced_locally
	const opening = notes.repo.notes.open({ stem }).then((note) => {
		if (destroyed) note.close();
		else held = note;
		return opened(note);
	});
	onDestroy(() => {
		destroyed = true;
		held?.close();
	});

	const folders = $derived(foldersOf(notes.folderFiles));

	/** Which view of the note shows. Switching writes nothing and discards nothing. */
	let tab = $state<'rich' | 'source'>('rich');

	/** A folder's option value. No folder is the empty value, so a folder id never is. */
	const optionOf = (id: string | null) => (id === null ? '' : `folder:${id}`);
	const idOf = (option: string) => (option === '' ? null : option.slice('folder:'.length));
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Note">
	{#await opening then note}
		{@const shown = note.current}
		{#if shown?.valid}
			{@const folderId = shown.fields.folderId}
			{@const pinned = shown.fields.pinned}
			<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
				<Input
					class="min-w-40 flex-1 text-base font-medium"
					bind:value={() => shown.fields.title, (title) => void report(note.set('title', title), 'Could not save the title')}
					placeholder="Title"
					aria-label="Title"
				/>
				<select
					class="h-9 max-w-40 rounded-md border bg-background px-2 text-sm"
					aria-label="Folder"
					value={optionOf(folderId)}
					onchange={(event) => void report(note.set('folderId', idOf(event.currentTarget.value)), 'Could not move the note')}
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
					onclick={() => void report(note.set('pinned', !pinned), 'Could not pin the note')}
				>
					<PinIcon class={pinned ? 'fill-current' : ''} />
				</Button>
				<Button size="sm" variant="ghost" tooltip="Show the whole file, including keys Honeycrisp does not show" onclick={() => notes.open(path, 'text')}>Show file</Button>
			</div>

			<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col">
				<Tabs.List class="mx-3">
					<Tabs.Trigger value="rich">Rich text</Tabs.Trigger>
					<Tabs.Trigger value="source">Source</Tabs.Trigger>
				</Tabs.List>
				<Tabs.Content value="rich" forceMount class="min-h-0 flex-1">
					<RichEditor
						note={{
							read: () => (note.current?.valid ? note.current.body.replace(/\r\n?/g, '\n') : undefined),
							write: (body) => void report(note.write({ body }), 'Could not save the note'),
						}}
						focusRequest={notes.focusRequest}
						onOpenSource={() => (tab = 'source')}
						onRefuse={(reason) => toast.warning('That edit was not made', { description: reason })}
					/>
				</Tabs.Content>
				<Tabs.Content value="source" class="flex min-h-0 flex-1 flex-col">
					<div class="flex min-h-0 flex-1 flex-col p-3">
						<Textarea
							class="min-h-40 flex-1 resize-none font-mono text-xs"
							bind:value={() => shown.body, (body) => void report(note.write({ body }), 'Could not save the note')}
							aria-label="Markdown source"
							spellcheck={false}
						/>
					</div>
				</Tabs.Content>
			</Tabs.Root>
		{:else if shown === null}
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
				<Button variant="outline" size="sm" onclick={() => notes.open(path, 'text')}>Show its text</Button>
			</Empty.Root>
		{/if}
	{/await}
</section>
