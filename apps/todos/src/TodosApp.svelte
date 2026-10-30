<!--
	Todos over the repository the shell opened, under its gate: the header,
	the list, and the open todo. Which todo is open is the app's path,
	`/<id>` (`/` for none), so it survives a reload and the breakpoint, and
	Back returns to the list.

	It mounts once, when the todos first arrive, and stays while the shell
	shows this repository. Where the repository syncs is the shell's bar.
-->
<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import * as Resizable from '@epicenter/ui/resizable';
	import { setRepository } from './repository.js';
	import { tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { AppProps } from '@epicenter/svelte/app';
	import type { manifest } from './definition.js';
	import { todoOf, todoPath } from './local-todos.js';
	import AppHeader from './AppHeader.svelte';
	import TodoDetail from './TodoDetail.svelte';
	import TodoList from './TodoList.svelte';

	let { repo, path, navigate }: AppProps<typeof manifest> = $props();

	// The repository stays fixed until this app root unmounts.
	// svelte-ignore state_referenced_locally
	setRepository(repo);

	/** The shared Modal's breakpoint: below it, the list and the open todo take turns. */
	const wide = new MediaQuery('(min-width: 768px)');
	/** The id of the todo the detail shows: the path's one segment. */
	const open = $derived(todoOf(path));
	let newTitle = $state('');

	/**
	 * Show the todo `id`, or none. Opening adds a history entry, so Back
	 * returns to the list; a delete replaces the entry, so Back never lands
	 * on a todo that is gone.
	 */
	async function show(id: string | undefined, { replaceState = false } = {}) {
		if (id === open) return;
		await navigate(id === undefined ? '/' : `/${encodeURIComponent(id)}`, { replace: replaceState });
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
			<Empty.Description>Each todo is a Markdown file in this repository.</Empty.Description>
		</Empty.Root>
	{:else}
		{#key open}
			<TodoDetail id={open} {onBack} onDeleted={() => void show(undefined, { replaceState: true })} />
		{/key}
	{/if}
{/snippet}

<div class="flex h-full flex-col overflow-hidden">
	<AppHeader pendingNewTodo={newTitle.trim() !== ''} />

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
