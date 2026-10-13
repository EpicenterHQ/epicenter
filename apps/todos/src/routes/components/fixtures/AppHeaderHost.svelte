<!-- The header as TodosView mounts it: the folder's store and query client in context, and the page's Sync. -->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { createMutation, setQueryClientContext } from '@tanstack/svelte-query';
	import type { TodosPlace } from '$lib/platform/types.js';
	import { setTodos, type Todos } from '$lib/todos.svelte.js';
	import AppHeader from '../AppHeader.svelte';

	let {
		todos,
		place,
		onchangeplace,
	}: { todos: Todos; place?: TodosPlace; onchangeplace?: () => void } = $props();
	// svelte-ignore state_referenced_locally
	setTodos(todos);
	// svelte-ignore state_referenced_locally
	setQueryClientContext(todos.queryClient);
	const sync = createMutation(() => todos.sync.run.options);
</script>

<Tooltip.Provider><AppHeader {sync} {place} {onchangeplace} /></Tooltip.Provider>
