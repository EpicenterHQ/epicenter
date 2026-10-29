<!--
	Todos over this device's repository, inside `<OpenTodos>`: the header,
	the list, and the open todo. Which todo is open is the URL's
	`?todo=<id>`, so it survives a reload and the breakpoint.

	It mounts once, when the todos first arrive, and stays for the page's
	life. The repository needs no account; it syncs only when a server is
	set. The header offers no Save version, Sync, or Connect.
-->
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import { setRepository, type TodosRepository } from '$lib/repository.js';
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { todoPath } from '$lib/local-todos.js';
	import AppHeader from './AppHeader.svelte';
	import TodoDetail from './TodoDetail.svelte';
	import TodoList from './TodoList.svelte';

	let {
		repo,
		repository,
		syncsTo,
		onLeave,
	}: {
		repo: TodosRepository;
		/** The repository's name in this browser. */
		repository: string;
		/** The server it syncs with, if any. */
		syncsTo?: string;
		/** Back to this browser's repositories. */
		onLeave: () => void;
	} = $props();

	// The repository stays fixed until this app root unmounts.
	// svelte-ignore state_referenced_locally
	setRepository(repo);

	/** The shared Modal's breakpoint: below it, the list and the open todo take turns. */
	const wide = new MediaQuery('(min-width: 768px)');
	/** The id of the todo the detail shows. */
	const open = $derived(page.url.searchParams.get('todo') ?? undefined);
	let newTitle = $state('');

	/**
	 * Show the todo `id`, or none. Opening adds a history entry, so Back
	 * returns to the list; a delete replaces the entry, so Back never lands
	 * on a todo that is gone.
	 */
	async function show(id: string | undefined, { replaceState = false } = {}) {
		if (id === open) return;
		const url = new URL(page.url);
		if (id === undefined) url.searchParams.delete('todo');
		else url.searchParams.set('todo', id);
		await goto(url, { replaceState, keepFocus: true, noScroll: true });
	}

	/** On narrow screens, return to the list, focused on the todo that was open. */
	async function back() {
		const id = open;
		await show(undefined);
		await tick();
		if (id !== undefined)
			document.querySelector<HTMLElement>(`[data-todo="${CSS.escape(todoPath(id))}"]`)?.focus();
	}
</script>

{#snippet detail(onBack?: () => void)}
	{#if open === undefined}
		<Empty.Root class="h-full">
			<Empty.Title>Select a todo to edit it</Empty.Title>
			<Empty.Description>Each todo is kept on this device{syncsTo === undefined ? '' : ' and synced'}.</Empty.Description>
		</Empty.Root>
	{:else}
		{#key open}
			<TodoDetail id={open} {onBack} onDeleted={() => void show(undefined, { replaceState: true })} />
		{/key}
	{/if}
{/snippet}

<div class="flex h-full flex-col overflow-hidden">
	<AppHeader pendingNewTodo={newTitle.trim() !== ''} {repository} {syncsTo} {onLeave} />

	{#if wide.current}
		<Resizable.PaneGroup direction="horizontal" class="min-h-0 flex-1">
			<Resizable.Pane id="list" order={1} defaultSize={38} minSize={20}>
				<TodoList {open} onOpen={(id) => void show(id)} bind:title={newTitle} />
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
				<TodoList {open} onOpen={(id) => void show(id)} bind:title={newTitle} />
			</div>
		</main>
	{/if}
</div>
