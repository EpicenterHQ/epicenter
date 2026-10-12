<!--
	The views of the opened folder: they find its store with `getTodos()`,
	and its query client through TanStack's provider.
-->
<script lang="ts">
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import { setTodos, type Todos } from '$lib/todos.svelte.js';

	let { todos, children }: { todos: Todos; children: Snippet } = $props();
	// A scope belongs to its folder for its whole life; it never changes store.
	// svelte-ignore state_referenced_locally
	setTodos(todos);
</script>

<QueryClientProvider client={todos.queryClient}>{@render children()}</QueryClientProvider>
