<!-- The whole Todos view as the page mounts it, with the tooltip provider the layout adds. -->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import type { Todos } from '$lib/todos.svelte.js';
	import TodosView from '../TodosView.svelte';

	let { todos }: { todos: Todos } = $props();
</script>

<Tooltip.Provider><TodosView {todos} /></Tooltip.Provider>
