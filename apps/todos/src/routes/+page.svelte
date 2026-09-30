<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { onDestroy } from 'svelte';
	import { openTodosFolder } from '$lib/folder.js';
	import { createTodos } from '$lib/todos.svelte.js';
	import TodosView from './components/TodosView.svelte';

	// The mounted page acquires the folder; importing modules opens nothing.
	const opening = openTodosFolder().then(async (folder) => {
		const todos = createTodos(folder);
		await todos.refreshAll();
		return todos;
	});

	onDestroy(() => {
		void opening.then((todos) => todos.close()).catch(() => {});
	});
</script>

{#await opening}
	<Loading class="h-dvh" label="Opening your todos…" />
{:then todos}
	<TodosView {todos} />
{:catch error}
	<Empty.Root class="h-dvh">
		<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
		<Empty.Title>Could not open the todos folder</Empty.Title>
		<Empty.Description>{error instanceof Error ? error.message : String(error)}</Empty.Description>
	</Empty.Root>
{/await}
