<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import { toast } from '@epicenter/ui/sonner';
	import SyncReview from '@epicenter/svelte/sync-review';
	import { createMutation, setQueryClientContext } from '@tanstack/svelte-query';
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { SyncAttempt, SyncChoices } from '@epicenter/folder';
	import { Err, Ok } from 'wellcrafted/result';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { syncOutcomeLine } from '$lib/status.js';
	import { todoPath } from '$lib/todo-listing.js';
	import { setTodos, type Todos } from '$lib/todos.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import IncomingBanner from './IncomingBanner.svelte';
	import TodoDetail from './TodoDetail.svelte';
	import TodoList from './TodoList.svelte';
	import DepartureNotice from './DepartureNotice.svelte';
	import type { Departure } from '@epicenter/epicenter/departure/page';
	import ConnectDialog from './ConnectDialog.svelte';
	import { takeConnectRequest } from '$lib/connect-request.js';

	let {
		todos,
		departure,
	}: {
		todos: Todos;
		departure?: Departure;
	} = $props();
	/** Connect shows; it opens by itself when GitHub just returned to it. */
	let connecting = $state(takeConnectRequest());

	// The views below find this folder's store with `getTodos()`, and its
	// query client through svelte-query. Svelte sets context only while a
	// component initializes, and the page has the store only after the folder
	// opens, so this view sets both. It belongs to one folder for its life.
	// svelte-ignore state_referenced_locally
	setTodos(todos);
	// svelte-ignore state_referenced_locally
	setQueryClientContext(todos.queryClient);

	// A write or action still running lives only in this page. Leaving the page then is cancelled; for a
	// reload or closed tab ('leave'), SvelteKit turns the cancel into the
	// browser's own leave confirmation. Opening another todo changes only the
	// query, stays on this page, and loses nothing.
	beforeNavigate(({ type, from, to, cancel }) => {
		if (!todos.departure.holdsUnsaved) return;
		if (type === 'leave' || to === null || to.url.pathname !== from?.url.pathname) cancel();
	});

	/**
	 * Sync and its review. A sync that needs choices fails with `NeedsChoices`;
	 * its attempt is the review, which shows until Apply ends it or Cancel
	 * forgets it.
	 */
	const sync = createMutation(() => todos.sync.run.options);
	const apply = createMutation(() => todos.sync.apply.options);
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
					const line = syncOutcomeLine(error ? Err(error) : Ok(outcome!), todos.git.snapshot);
					const notify = line.tone === 'good' ? toast.success : line.tone === 'error' ? toast.error : toast.warning;
					notify(line.label, { description: line.detail });
				},
			},
		);
	}

	/** The shared Modal's breakpoint: below it, the list and the open todo take turns. */
	const wide = new MediaQuery('(min-width: 768px)');
	/**
	 * The stem of the todo the detail shows: the URL's `?todo=<stem>`, so it
	 * survives a reload and the breakpoint. Opening never waits or asks.
	 */
	const open = $derived(page.url.searchParams.get('todo') ?? undefined);

	/**
	 * Show the todo `stem`, or none. Opening adds a history entry, so Back
	 * returns to the list; a delete replaces the entry, so Back
	 * never lands on a name that is gone.
	 */
	async function show(stem: string | undefined, { replaceState = false } = {}) {
		if (stem === open) return;
		const url = new URL(page.url);
		if (stem === undefined) url.searchParams.delete('todo');
		else url.searchParams.set('todo', stem);
		await goto(url, { replaceState, keepFocus: true, noScroll: true });
	}

	/** On narrow screens, return to the list, focused on the todo that was open. */
	async function back() {
		const stem = open;
		await show(undefined);
		await tick();
		if (stem !== undefined)
			document.querySelector<HTMLElement>(`[data-todo="${CSS.escape(todoPath(stem))}"]`)?.focus();
	}
</script>

{#snippet detail(onBack?: () => void)}
	{#if open === undefined}
		<Empty.Root class="h-full">
			<Empty.Title>Select a todo to edit it</Empty.Title>
			<Empty.Description>Each todo is a Markdown file in <code>todos/</code>.</Empty.Description>
		</Empty.Root>
	{:else}
		{#key open}
			<TodoDetail
				stem={open}
				{onBack}
				onDeleted={() => void show(undefined, { replaceState: true })}
			/>
		{/key}
	{/if}
{/snippet}

<!--
	While Epicenter asks to quit or restart, the whole page takes no input; the
	store also refuses every action, which covers menus and dialogs that render
	outside this element.
-->
<div class="flex h-dvh flex-col overflow-hidden" inert={todos.departing}>
	<AppHeader {sync} reviewing={attempt !== undefined} onconnect={() => (connecting = true)} />
	<ConnectDialog bind:open={connecting} {sync} />
	{#if departure}
		<DepartureNotice {departure} />
	{/if}
	<IncomingBanner />

	{#if attempt !== undefined}
		<!--
			The review is modal: it covers the workspace until it is applied or
			cancelled. The workspace is hidden, not unmounted, so what the person
			typed there is still there afterwards.
		-->
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
	{/if}
	{#if wide.current}
		<Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1" hidden={attempt !== undefined}>
			<Resizable.Pane id="list" order={1} defaultSize={38} minSize={20}>
				<TodoList {open} onOpen={(stem) => void show(stem)} />
			</Resizable.Pane>
			<Resizable.Handle />
			<Resizable.Pane id="detail" order={2} defaultSize={62} minSize={30}>
				{@render detail()}
			</Resizable.Pane>
		</Resizable.PaneGroup>
	{:else}
		<main class="min-h-0 flex-1" hidden={attempt !== undefined}>
			{#if open !== undefined}
				{@render detail(back)}
			{/if}
			<!-- Hidden, not unmounted, behind the detail: a typed title stays. -->
			<div class="h-full" hidden={open !== undefined}>
				<TodoList {open} onOpen={(stem) => void show(stem)} />
			</div>
		</main>
	{/if}
</div>
