<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import { toast } from '@epicenter/ui/sonner';
	import { tick } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import type { Notes } from '$lib/notes.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import FileBrowser from './FileBrowser.svelte';
	import FileView from './FileView.svelte';
	import FolderNav from './FolderNav.svelte';
	import FolderTerminal from './FolderTerminal.svelte';
	import NoteDetail from './NoteDetail.svelte';
	import NoteList from './NoteList.svelte';

	let { notes }: { notes: Notes } = $props();

	let filesOpen = $state(false);
	let terminalOpen = $state(false);

	// Writes and actions run in this window. A reload or in-page navigation
	// waits while one runs: it is cancelled here, and the webview asks first.
	// Closing the window or quitting the app asks the page, which answers once
	// they land (`+page.svelte`); while it answers, `notes.fenced` holds back
	// every input and action here.
	beforeNavigate(({ cancel }) => {
		if (notes.busy) cancel();
	});

	async function toggleTerminal() {
		terminalOpen = !terminalOpen;
		if (terminalOpen) return;
		await tick();
		if (document.activeElement === null || document.activeElement === document.body)
			document.querySelector<HTMLElement>('[data-terminal-toggle]')?.focus();
	}
</script>

<!-- Returning to the window reads the lists, the open file, and Git status
     again, through the query cache; nothing is read while a write runs. -->
<svelte:window
	onbeforeunload={(event) => {
		if (notes.busy) event.preventDefault();
	}}
	onkeydown={async (event) => {
		const mod = event.metaKey || event.ctrlKey;
		if ((event.key === 'F5' || (mod && event.key.toLowerCase() === 'r')) && notes.busy) {
			// A reload would stop a write in flight. The leave prompt below is
			// the webview's to show or not; refusing the shortcut does not depend on it.
			event.preventDefault();
			toast.warning('Reload stopped: a change is still being saved', {
				description: 'Reload again once it finishes.',
			});
		} else if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
			event.preventDefault();
			filesOpen = !filesOpen;
		} else if (notes.terminal && event.ctrlKey && event.key === '`') {
			event.preventDefault();
			void toggleTerminal();
		} else if (mod && !event.shiftKey && event.key.toLowerCase() === 'n') {
			event.preventDefault();
			const problem = await notes.createNote();
			if (problem) toast.error('Could not create the note', { description: problem });
		}
	}}
/>

<!-- While a close is being answered nothing here takes input. The editors stay
     mounted, so a refused approval returns to the same text and undo history. -->
<div class="flex h-dvh flex-col overflow-hidden" inert={notes.fenced}>
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
					{@const shown = notes.selected}
					{#if shown?.as === 'note'}
						<!-- One mount per opening: a rename keeps it, and its undo history. -->
						{#key shown.id}
							<NoteDetail {notes} path={shown.path} />
						{/key}
					{:else if shown !== undefined}
						{#key shown.id}
							<FileView {notes} path={shown.path} />
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
						<FileBrowser {notes} />
					</Resizable.Pane>
				{/if}
			</Resizable.PaneGroup>
		</Resizable.Pane>
		{#if terminalOpen && notes.terminal}
			<Resizable.Handle />
			<Resizable.Pane id="terminal" order={2} defaultSize={32} minSize={15} maxSize={70}>
				<FolderTerminal session={notes.terminal} onClose={() => void toggleTerminal()} />
			</Resizable.Pane>
		{/if}
	</Resizable.PaneGroup>
</div>
