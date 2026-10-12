<!--
	Mounts the real list and the real TodoDetail as TodosView does on a wide
	screen: the list opens a todo, and the detail is keyed by the stem it
	shows, inside the folder's scope and the tooltip provider.
-->
<script lang="ts">
	import type { Todos } from '$lib/todos.svelte.js';
	import TodoDetail from '../TodoDetail.svelte';
	import TodoList from '../TodoList.svelte';
	import QueryHost from './QueryHost.svelte';

	let { todos }: { todos: Todos } = $props();
	let open = $state<string | undefined>();
</script>

<QueryHost {todos}>
	<div data-host="list"><TodoList {open} onOpen={(stem) => (open = stem)} /></div>
	<div data-host="detail" data-open={open}>
		{#if open !== undefined}
			{#key open}
				<TodoDetail
					stem={open}
					onRenamed={(next) => (open = next)}
					onDeleted={() => (open = undefined)}
				/>
			{/key}
		{/if}
	</div>
</QueryHost>
