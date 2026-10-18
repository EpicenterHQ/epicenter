<!--
	The detail pane: the one open item. A todo from the list is its fields and
	notes; a file from Files, or a todo whose text is not a valid row, is its
	text. Each view is keyed by the open item, so another item mounts a new
	view and a view never changes sessions.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import { rowStemOf } from '@epicenter/folder';
	import { FileView } from '@epicenter/svelte/folder-ui';
	import { todosDefinition } from '$lib/definition.js';
	import { pathOf, type Todos } from '$lib/todos.svelte.js';
	import { confirmDelete, openItem } from './file-actions.js';
	import TodoDetail from './TodoDetail.svelte';

	let { todos, onBack }: { todos: Todos; onBack?: () => void } = $props();

	const item = $derived(todos.opened);
</script>

{#if item === undefined}
	<Empty.Root class="h-full">
		<Empty.Title>Select a todo to edit it</Empty.Title>
		<Empty.Description>Files opens any file, a todo's Markdown included, as text.</Empty.Description>
		{#if onBack}
			<Button variant="outline" size="sm" onclick={onBack}><ArrowLeftIcon /> Back to todos</Button>
		{/if}
	</Empty.Root>
{:else if item.kind === 'todo'}
	{#key item}
		<TodoDetail {todos} session={item.session} {onBack} />
	{/key}
{:else}
	{#key item}
		{@const path = pathOf(item)}
		<FileView
			{path}
			{item}
			row={rowStemOf(todos.folder.tables.todos.name, path) === undefined
				? undefined
				: {
						table: todosDefinition.tables.todos,
						noun: 'todo',
						onOpenAsRow: () => void openItem(todos, path, 'todos'),
					}}
			backLabel="Back to todos"
			{onBack}
			onRetry={() => void todos.reload()}
			onReloadTheirs={(session) => todos.reloadTheirs(session)}
			onKeepMine={(session) => todos.keepMine(session)}
			onRename={(next) => todos.rename(path, next)}
			onDelete={() => void confirmDelete(todos, path)}
		/>
	{/key}
{/if}
