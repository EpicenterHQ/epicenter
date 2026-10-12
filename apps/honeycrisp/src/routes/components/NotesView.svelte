<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import { toast } from '@epicenter/ui/sonner';
	import { tick } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { rowStemOf } from '@epicenter/folder';
	import { FileBrowser, FileView, FolderTerminal } from '@epicenter/svelte/folder-ui';
	import NotebookTextIcon from '@lucide/svelte/icons/notebook-text';
	import { honeycrispDefinition, noteIdOf } from '$lib/data.js';
	import { type Notes, pathOf } from '$lib/notes.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import { confirmDelete, openItem } from './file-actions.js';
	import FolderNav from './FolderNav.svelte';
	import NoteDetail from './NoteDetail.svelte';
	import NoteList from './NoteList.svelte';

	let { notes }: { notes: Notes } = $props();

	let filesOpen = $state(false);
	let terminalOpen = $state(false);

	// Drafts live only in this window. Unloading it while the open item's save
	// runs or failed, or an action runs, raises the browser's own "Leave
	// site?". Closing the desktop window waits for `+page.svelte`'s close.
	beforeNavigate((navigation) => {
		if (navigation.willUnload && notes.unsettled > 0) navigation.cancel();
	});

	async function toggleTerminal() {
		terminalOpen = !terminalOpen;
		if (terminalOpen) return;
		await tick();
		if (document.activeElement === null || document.activeElement === document.body)
			document.querySelector<HTMLElement>('[data-terminal-toggle]')?.focus();
	}

	/** The table a row file at `path` belongs to, so its text is checked as a row. */
	function rowOf(path: string) {
		if (noteIdOf(path) !== undefined)
			return {
				table: honeycrispDefinition.tables.notes,
				noun: 'note',
				onOpenAsRow: () => void openItem(notes, path, 'note'),
			};
		if (rowStemOf('folders', path) !== undefined)
			return { table: honeycrispDefinition.tables.folders, noun: 'folder' };
		return undefined;
	}
</script>

<!-- Returning to the app reads the lists and Git status again. An open note
     keeps its draft: a change made elsewhere shows as a conflict on its next save. -->
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'visible') void notes.check();
	}}
/>
<svelte:window
	onfocus={() => void notes.check()}
	onkeydown={async (event) => {
		const mod = event.metaKey || event.ctrlKey;
		if ((event.key === 'F5' || (mod && event.key.toLowerCase() === 'r')) && notes.unsettled > 0) {
			// A reload would end this window's drafts. The leave prompt is the
			// webview's to show or not; refusing the shortcut does not depend on it.
			event.preventDefault();
			toast.warning('Reload stopped: the open note is not saved', {
				description: 'Wait for them to save, or resolve them in the note, then reload.',
			});
		} else if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
			event.preventDefault();
			filesOpen = !filesOpen;
		} else if (event.ctrlKey && event.key === '`') {
			event.preventDefault();
			void toggleTerminal();
		} else if (mod && !event.shiftKey && event.key.toLowerCase() === 'n') {
			event.preventDefault();
			const problem = await notes.createNote();
			if (problem) toast.error('Could not create the note', { description: problem });
		}
	}}
/>

<div class="flex h-dvh flex-col overflow-hidden">
	<AppHeader
		{notes}
		{filesOpen}
		{terminalOpen}
		onToggleFiles={() => (filesOpen = !filesOpen)}
		onToggleTerminal={() => void toggleTerminal()}
	/>

	<Resizable.PaneGroup direction="vertical" class="min-h-0 flex-1">
		<Resizable.Pane id="main" order={1} minSize={30}>
			<Resizable.PaneGroup direction="horizontal">
				<Resizable.Pane id="folders" order={1} defaultSize={16} minSize={10} maxSize={30}>
					<FolderNav {notes} />
				</Resizable.Pane>
				<Resizable.Handle />
				<Resizable.Pane id="list" order={2} defaultSize={24} minSize={15}>
					<NoteList {notes} />
				</Resizable.Pane>
				<Resizable.Handle />
				<Resizable.Pane id="detail" order={3} defaultSize={filesOpen ? 40 : 60} minSize={30}>
					{@const opened = notes.opened}
					{#if opened?.kind === 'note'}
						<!-- One mount per session: leaving the note releases it. -->
						{#key opened.session}
							<NoteDetail {notes} session={opened.session} />
						{/key}
					{:else if opened !== undefined}
						{#key opened}
							{@const path = pathOf(opened)}
							<FileView
								{path}
								item={opened}
								row={rowOf(path)}
								onRetry={() => void openItem(notes, path)}
								onReloadTheirs={(session) => notes.reloadTheirs(session)}
								onKeepMine={(session) => notes.keepMine(session)}
								onRename={(next) => notes.rename(path, next)}
								onDelete={() => void confirmDelete(notes, path)}
							/>
						{/key}
					{:else}
						<Empty.Root class="h-full">
							<Empty.Title>No note selected</Empty.Title>
							<Empty.Description>Choose a note from the list, or press ⌘N to create one.</Empty.Description>
						</Empty.Root>
					{/if}
				</Resizable.Pane>
				{#if filesOpen}
					<Resizable.Handle />
					<Resizable.Pane id="files" order={4} defaultSize={20} minSize={14} maxSize={40}>
						<FileBrowser
							listing={notes.listing}
							listingError={notes.listingError}
							expanded={notes.expanded}
							selected={(path) => notes.selectedPath === path}
							icon={(path) => (notes.isNote(path) ? NotebookTextIcon : undefined)}
							emptyDescription="Create a note, or a file or folder above."
							location={notes.host.location}
							onRefresh={() => void notes.refresh()}
							onReveal={notes.host.reveal}
							onOpen={(path) => void openItem(notes, path)}
							onCreate={(directory, name, type) =>
								type === 'file' ? notes.createFile(directory, name) : notes.createDirectory(directory, name)}
							onRename={(path, name) => notes.rename(path, name)}
							onDelete={(path) => void confirmDelete(notes, path)}
						/>
					</Resizable.Pane>
				{/if}
			</Resizable.PaneGroup>
		</Resizable.Pane>
		{#if terminalOpen}
			<Resizable.Handle />
			<Resizable.Pane id="terminal" order={2} defaultSize={32} minSize={15} maxSize={70}>
				<FolderTerminal session={notes.terminal} description={notes.host.terminal.description} onClose={() => void toggleTerminal()} />
			</Resizable.Pane>
		{/if}
	</Resizable.PaneGroup>
</div>
