<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import { getFolder } from '@epicenter/svelte/folder';
	import { createMutation } from '@tanstack/svelte-query';
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { todoPath } from '$lib/todo-listing.js';
	import type { todosDefinition } from '$lib/definition.js';
	import { createTodos, setTodos } from '$lib/todos.svelte.js';
	import AppHeader from './AppHeader.svelte';
	import TodoDetail from './TodoDetail.svelte';
	import TodoList from './TodoList.svelte';
	import ConnectDialog from './ConnectDialog.svelte';
	import { takeConnectRequest } from '$lib/connect-request.js';

	// The store over the folder `<FolderApp>` opened. The views below find it
	// with `getTodos()`, and the page's query client through svelte-query.
	// This view belongs to one folder for its life.
	const todos = createTodos(getFolder<typeof todosDefinition>());
	setTodos(todos);
	/**
	 * Whether this folder offers Connect: Todos's own folder only, since
	 * Epicenter's server keeps one repository per app id for now.
	 */
	const canConnect = todos.isOwn;
	/** Connect shows; it opens by itself when sign-in just returned to it. */
	let connecting = $state(canConnect && takeConnectRequest());

	// A write or action still running lives only in this page. Leaving the page then is cancelled; for a
	// reload or closed tab ('leave'), SvelteKit turns the cancel into the
	// browser's own leave confirmation. Opening another todo changes only the
	// query, stays on this page, and loses nothing.
	beforeNavigate(({ type, from, to, cancel }) => {
		if (!todos.holdsUnsaved) return;
		if (type === 'leave' || to === null || to.url.pathname !== from?.url.pathname) cancel();
	});

	/** The page's Sync, which the header and Connect both run. */
	const sync = createMutation(() => todos.sync.run.options);

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

<div class="flex h-dvh flex-col overflow-hidden">
	<AppHeader {sync} onconnect={canConnect ? () => (connecting = true) : undefined} />
	{#if canConnect}<ConnectDialog bind:open={connecting} {sync} />{/if}

	{#if wide.current}
		<Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1">
			<Resizable.Pane id="list" order={1} defaultSize={38} minSize={20}>
				<TodoList {open} onOpen={(stem) => void show(stem)} />
			</Resizable.Pane>
			<Resizable.Handle />
			<Resizable.Pane id="detail" order={2} defaultSize={62} minSize={30}>
				{@render detail()}
			</Resizable.Pane>
		</Resizable.PaneGroup>
	{:else}
		<main class="min-h-0 flex-1">
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
