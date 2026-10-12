<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import * as Sheet from '@epicenter/ui/sheet';
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { type Snippet, tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { type Session, setSession } from '$lib/session.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import BottomNav from './BottomNav.svelte';
	import { joinPath } from '@epicenter/folder/file-browser';
	import { FileBrowser, FolderTerminal } from '@epicenter/svelte/folder-ui';
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';
	import MicIcon from '@lucide/svelte/icons/mic';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { audioMimeTypeOf } from '$lib/audio-format.js';
	import RecoveryNotices from './RecoveryNotices.svelte';
	import VerticalNav from './VerticalNav.svelte';
	import { confirmDelete, openItem } from './file-actions.js';

	/**
	 * The frame every page sits in: navigation, the header with status and
	 * tools, what is not saved yet, the file browser, and the terminal. It
	 * mounts once with the session and stays while pages change inside it.
	 */
	let { session, children }: { session: Session; children: Snippet } = $props();

	// One session per mounted layout: the layout opens it once and never swaps it.
	// svelte-ignore state_referenced_locally
	const { library, view } = session;
	// svelte-ignore state_referenced_locally
	setSession(session);

	// Typing, captured audio, and received text that have not reached the folder
	// live only in this window. Moving between this app's pages keeps all of it,
	// so that is never held back. Leaving the document is: in a browser tab the
	// cancel becomes the browser's leave warning. Closing the desktop window is
	// the layout's: it waits for the session to close, asking first only while
	// a recording is in progress.
	beforeNavigate((navigation) => {
		// svelte-ignore state_referenced_locally
		if (session.blocksNavigation(navigation)) navigation.cancel();
	});

	/** Below this width the sidebar becomes a bottom bar and panes take turns. */
	const wide = new MediaQuery('(min-width: 768px)');

	function toggleFiles() {
		if (wide.current) view.filesPane = !view.filesPane;
		else view.filesSheet = !view.filesSheet;
	}

	async function toggleTerminal() {
		view.terminalOpen = !view.terminalOpen;
		if (view.terminalOpen) return;
		// The command field left with the terminal; give focus back to its toggle.
		await tick();
		if (document.activeElement === null || document.activeElement === document.body)
			document.querySelector<HTMLElement>('[data-terminal-toggle]')?.focus();
	}

	/** Show what was just opened: a transformation on its page, anything else beside the recordings. */
	function showOpened(path: string) {
		view.filesSheet = false;
		if (!wide.current) view.terminalOpen = false;
		if (library.selectedTransformationPath === path) {
			view.showingTransformation = true;
			void goto(resolve('/transformations'));
		} else {
			view.showingDetail = true;
			void goto(resolve('/recordings'));
		}
	}

	/** Open a recording beside the recordings, or a transformation on its page. */
	async function openRecording(path: string) {
		if (await openItem(library, path)) showOpened(path);
	}
</script>

<!-- Returning to the app is a refresh boundary for files and Git status. -->
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'visible') void library.check();
	}}
/>
<svelte:window
	onfocus={() => void library.check()}
	onkeydown={(event) => {
		if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'e') {
			event.preventDefault();
			toggleFiles();
		} else if (event.ctrlKey && event.key === '`') {
			event.preventDefault();
			void toggleTerminal();
		}
	}}
/>

{#snippet header()}
	<AppHeader
		{library}
		filesOpen={wide.current ? view.filesPane : view.filesSheet}
		terminalOpen={view.terminalOpen}
		onToggleFiles={toggleFiles}
		onToggleTerminal={() => void toggleTerminal()}
	/>
	<RecoveryNotices
		{library}
		onOpenRecording={(path) => void openRecording(path)}
		onOpenTransformation={(path) => void openRecording(path)}
	/>
{/snippet}

{#snippet files()}
	<FileBrowser
		listing={library.listing}
		listingError={library.listingError}
		expanded={library.expanded}
		selected={(path) => library.selectedPath === path || library.selectedTransformationPath === path}
		icon={(path) =>
			library.isRecording(path)
				? MicIcon
				: library.isTransformation(path)
					? WandSparklesIcon
					: audioMimeTypeOf(path) !== undefined
						? AudioLinesIcon
						: undefined}
		emptyDescription="Record something, or create a file or folder above."
		onRefresh={() => void library.refresh()}
		onOpen={(path) => void openItem(library, path).then((opened) => opened && showOpened(path))}
		onCreate={async (directory, name, type) => {
			const problem =
				type === 'file' ? await library.createFile(directory, name) : await library.createFolder(directory, name);
			if (problem === undefined && type === 'file') showOpened(joinPath(directory, name));
			return problem;
		}}
		onRename={(path, name) => library.rename(path, name)}
		onDelete={(path) => void confirmDelete(library, path)}
	/>
{/snippet}

{#snippet terminalPane()}
	<FolderTerminal session={library.terminal} description={library.workspace.terminalNote} onClose={() => void toggleTerminal()} />
{/snippet}

{#if wide.current}
	<Sidebar.Provider bind:open={view.sidebarOpen} class="h-dvh min-h-0 overflow-hidden">
		<VerticalNav />
		<Sidebar.Inset class="min-h-0 overflow-hidden">
			{@render header()}
			<Resizable.PaneGroup direction="vertical" class="min-h-0 flex-1">
				<Resizable.Pane id="workspace" order={1} minSize={30}>
					<Resizable.PaneGroup direction="horizontal">
						{#if view.filesPane}
							<Resizable.Pane id="files" order={1} defaultSize={22} minSize={14} maxSize={40}>
								{@render files()}
							</Resizable.Pane>
							<Resizable.Handle />
						{/if}
						<Resizable.Pane id="page" order={2} defaultSize={view.filesPane ? 78 : 100} minSize={40}>
							<div class="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="page">{@render children()}</div>
						</Resizable.Pane>
					</Resizable.PaneGroup>
				</Resizable.Pane>
				{#if view.terminalOpen}
					<Resizable.Handle />
					<Resizable.Pane id="terminal" order={2} defaultSize={32} minSize={15} maxSize={70}>
						{@render terminalPane()}
					</Resizable.Pane>
				{/if}
			</Resizable.PaneGroup>
		</Sidebar.Inset>
	</Sidebar.Provider>
{:else}
	<div class="flex h-dvh flex-col overflow-hidden">
		{@render header()}
		<main class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="page">
			{#if view.terminalOpen}
				{@render terminalPane()}
			{:else}
				{@render children()}
			{/if}
		</main>
		<BottomNav />
		<Sheet.Root bind:open={view.filesSheet}>
			<!-- Named directly: the browser's own visible heading is the only "Files" heading. -->
			<Sheet.Content side="left" class="gap-0 p-0" aria-label="Files">
				{@render files()}
			</Sheet.Content>
		</Sheet.Root>
	</div>
{/if}
