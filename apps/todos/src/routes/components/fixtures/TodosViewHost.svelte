<!-- The whole Todos view as the page mounts it, inside what the layout supplies. -->
<script lang="ts">
	import type { Todos } from '$lib/todos.svelte.js';
	import TodosView from '../TodosView.svelte';
	import QueryHost from './QueryHost.svelte';

	let { todos }: { todos: Todos } = $props();
</script>

<QueryHost {todos}>
	<TodosView />
</QueryHost>
