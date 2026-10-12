<script lang="ts">
	import * as Resizable from '@epicenter/ui/resizable';
	import * as Sheet from '@epicenter/ui/sheet';
	import { toast } from '@epicenter/ui/sonner';
	import SyncReview from '@epicenter/svelte/sync-review';
	import { createMutation } from '@tanstack/svelte-query';
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { SyncAttempt, SyncChoices } from '@epicenter/folder';
	import { Err, Ok } from 'wellcrafted/result';
	import { beforeNavigate } from '$app/navigation';
	import { syncOutcomeLine } from '$lib/status.js';
	import type { Todos } from '$lib/todos.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import Detail from './Detail.svelte';
	import IncomingBanner from './IncomingBanner.svelte';
	import FileBrowser from './FileBrowser.svelte';
	import FolderTerminal from './FolderTerminal.svelte';
	import TodoList from './TodoList.svelte';
	import DepartureNotice from './DepartureNotice.svelte';
	import type { Departure } from '@epicenter/epicenter/departure/page';

	let { todos, departure }: { todos: Todos; departure?: Departure } = $props();

	// A write or action still running, or a new todo's typed title, lives
	// only in this page. Leaving then is cancelled; for a reload or closed
	// tab ('leave'), SvelteKit turns the cancel into the browser's own leave
	// confirmation.
	beforeNavigate(({ cancel }) => {
		if (todos.departure.holdsUnsaved) cancel();
	});

	const directory = $derived(
		todos.folder.location.kind === 'directory' ? todos.folder.location.root : undefined,
	);

	/**
	 * Sync and its review. A sync that needs choices fails with `NeedsChoices`;
	 * its attempt is the review, which shows until Apply ends it or Cancel
	 * forgets it.
	 */
	const sync = createMutation(() => todos.sync.options);
	const apply = createMutation(() => todos.apply.options);
	const attempt = $derived(sync.error?.name === 'NeedsChoices' ? sync.error.attempt : undefined);

	function cancelReview() {
		sync.reset();
		apply.reset();
	}

	/** Apply the review's choices; refused ones stay in the review, marked. */
	function applyReview(answered: SyncAttempt, choices: SyncChoices) {
		apply.mutate(
			{ attempt: answered, choices },
			{
				onSettled: (outcome, error) => {
					if (error?.name === 'InvalidChoices') return;
					cancelReview();
					const line = syncOutcomeLine(error ? Err(error) : Ok(outcome!), todos.git);
					const notify = line.tone === 'good' ? toast.success : line.tone === 'error' ? toast.error : toast.warning;
					notify(line.label, { description: line.detail });
				},
			},
		);
	}

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
		const path = todos.selected?.path;
		showingDetail = false;
		await tick();
		if (path !== undefined)
			document.querySelector<HTMLElement>(`[data-todo="${CSS.escape(path)}"]`)?.focus();
	}
</script>

<svelte:window
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

<div class="flex h-dvh flex-col overflow-hidden">
	<AppHeader
		{todos}
		{sync}
		reviewing={attempt !== undefined}
		filesOpen={wide.current ? filesPane : filesSheet}
		{terminalOpen}
		onToggleFiles={toggleFiles}
		onToggleTerminal={() => void toggleTerminal()}
	/>
	{#if departure}
		<DepartureNotice {departure} />
	{/if}
	<IncomingBanner {todos} />

	{#if attempt !== undefined}
		<!-- The review is modal: it replaces the workspace until it is applied or cancelled. -->
		<div class="min-h-0 flex-1 overflow-y-auto p-4">
			{#key attempt.id}
				<SyncReview
					{attempt}
					pending={apply.isPending}
					problems={apply.error?.name === 'InvalidChoices' ? apply.error.problems : []}
					onCancel={cancelReview}
					onApply={applyReview}
				/>
			{/key}
		</div>
	{:else if wide.current}
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
						<Detail {todos} />
					</Resizable.Pane>
				</Resizable.PaneGroup>
			</Resizable.Pane>
			{#if terminalOpen}
				<Resizable.Handle />
				<Resizable.Pane id="terminal" order={2} defaultSize={32} minSize={15} maxSize={70}>
					<FolderTerminal session={todos.terminal} {directory} onClose={() => void toggleTerminal()} />
				</Resizable.Pane>
			{/if}
		</Resizable.PaneGroup>
	{:else}
		<main class="min-h-0 flex-1">
			{#if terminalOpen}
				<FolderTerminal session={todos.terminal} {directory} onClose={() => void toggleTerminal()} />
			{:else if showingDetail}
				<Detail {todos} onBack={back} />
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
