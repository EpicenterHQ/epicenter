<!--
	The views of one opened folder: they find its store with `getTodos()`,
	and its query client through TanStack's provider. A page with two folders
	would render two scopes.
-->
<script lang="ts">
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import { setTodos, type Todos } from '$lib/todos.svelte.js';

	let { todos, children }: { todos: Todos; children: Snippet } = $props();
	// A scope belongs to one folder for its whole life; it never changes store.
	// svelte-ignore state_referenced_locally
	setTodos(todos);
</script>

<QueryClientProvider client={todos.queryClient}>{@render children()}</QueryClientProvider>
