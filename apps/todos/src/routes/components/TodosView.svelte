<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import * as Sheet from '@epicenter/ui/sheet';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { beforeNavigate } from '$app/navigation';
	import { basename } from '$lib/files.js';
	import type { Todos } from '$lib/todos.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import FileBrowser from './FileBrowser.svelte';
	import FileView from './FileView.svelte';
	import FolderTerminal from './FolderTerminal.svelte';
	import TodoDetail from './TodoDetail.svelte';
	import TodoList from './TodoList.svelte';

	let { todos }: { todos: Todos } = $props();

	// Drafts live only in this open page. While any editor has typing, a save
	// in flight, a failed save, or a conflict, leaving is cancelled; for a
	// reload or closed tab ('leave'), SvelteKit turns the cancel into the
	// browser's own leave confirmation.
	beforeNavigate(({ cancel }) => {
		if (todos.unsaved) cancel();
	});

	/** The shared Modal's breakpoint: below it, the list, editor, and terminal take turns. */
	const wide = new MediaQuery('(min-width: 768px)');
	let filesPane = $state(true);
	let filesSheet = $state(false);
	let terminalOpen = $state(false);
	/** On narrow screens, whether the editor shows in place of the list. */
	let showingDetail = $state(false);

	function toggleFiles() {
		if (wide.current) filesPane = !filesPane;
		else filesSheet = !filesSheet;
	}

	async function toggleTerminal() {
		terminalOpen = !terminalOpen;
		if (terminalOpen) return;
		// The command field left with the terminal; give focus back to its toggle.
		await tick();
		if (document.activeElement === null || document.activeElement === document.body)
			document.querySelector<HTMLElement>('[data-terminal-toggle]')?.focus();
	}

	function showDetail() {
		if (wide.current) return;
		showingDetail = true;
		filesSheet = false;
		terminalOpen = false;
	}

	async function back() {
		const path = todos.selectedPath;
		showingDetail = false;
		await tick();
		if (path !== undefined)
			document.querySelector<HTMLElement>(`[data-todo="${CSS.escape(path)}"]`)?.focus();
	}
</script>

<!-- Returning to the app is a refresh boundary for files and Git status. -->
<svelte:window
	onfocus={() => void todos.refreshAll()}
	onkeydown={(event) => {
		if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
			event.preventDefault();
			toggleFiles();
		} else if (event.ctrlKey && event.key === '`') {
			event.preventDefault();
			void toggleTerminal();
		}
	}}
/>

{#snippet detail(onBack: (() => void) | undefined)}
	{@const selection = todos.selection}
	{#if selection?.kind === 'todo'}
		<TodoDetail {todos} editor={selection.editor} entry={selection.entry} {onBack} />
	{:else if selection?.kind === 'file'}
		<FileView {todos} path={selection.path} file={selection.file} {onBack} />
	{:else}
		<Empty.Root class="h-full">
			{#if todos.selectedPath !== undefined}
				<Empty.Title>{basename(todos.selectedPath)} is no longer in the folder</Empty.Title>
				<Empty.Description>It was renamed or deleted outside this editor.</Empty.Description>
			{:else}
				<Empty.Title>Select a todo to edit it</Empty.Title>
				<Empty.Description>Any other file opens from the file browser.</Empty.Description>
			{/if}
			{#if onBack}
				<Button variant="outline" size="sm" onclick={onBack}><ArrowLeftIcon /> Back to todos</Button>
			{/if}
		</Empty.Root>
	{/if}
{/snippet}

<div class="flex h-dvh flex-col overflow-hidden">
	<AppHeader
		{todos}
		filesOpen={wide.current ? filesPane : filesSheet}
		{terminalOpen}
		onToggleFiles={toggleFiles}
		onToggleTerminal={() => void toggleTerminal()}
	/>

	{#if wide.current}
		<Resizable.PaneGroup direction="vertical" class="min-h-0 flex-1">
			<Resizable.Pane id="workspace" order={1} minSize={30}>
				<Resizable.PaneGroup direction="horizontal">
					{#if filesPane}
						<Resizable.Pane id="files" order={1} defaultSize={22} minSize={14} maxSize={40}>
							<FileBrowser {todos} />
						</Resizable.Pane>
						<Resizable.Handle />
					{/if}
					<Resizable.Pane id="list" order={2} defaultSize={filesPane ? 30 : 38} minSize={20}>
						<TodoList {todos} />
					</Resizable.Pane>
					<Resizable.Handle />
					<Resizable.Pane id="detail" order={3} defaultSize={filesPane ? 48 : 62} minSize={30}>
						{@render detail(undefined)}
					</Resizable.Pane>
				</Resizable.PaneGroup>
			</Resizable.Pane>
			{#if terminalOpen}
				<Resizable.Handle />
				<Resizable.Pane id="terminal" order={2} defaultSize={32} minSize={15} maxSize={70}>
					<FolderTerminal session={todos.terminal} onClose={() => void toggleTerminal()} />
				</Resizable.Pane>
			{/if}
		</Resizable.PaneGroup>
	{:else}
		<main class="min-h-0 flex-1">
			{#if terminalOpen}
				<FolderTerminal session={todos.terminal} onClose={() => void toggleTerminal()} />
			{:else if showingDetail}
				{@render detail(back)}
			{:else}
				<TodoList {todos} onOpen={showDetail} />
			{/if}
		</main>
		<Sheet.Root bind:open={filesSheet}>
			<!-- Named directly: the browser's own visible heading is the only "Files" heading. -->
			<Sheet.Content side="left" class="gap-0 p-0" aria-label="Files">
				<FileBrowser {todos} onOpen={showDetail} />
			</Sheet.Content>
		</Sheet.Root>
	{/if}
</div>
