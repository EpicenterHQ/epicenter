<!-- What the layout supplies to every page: the app's one query client and the tooltip provider. -->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import type { Todos } from '$lib/todos.svelte.js';

	let { todos, children }: { todos: Todos; children: Snippet } = $props();
</script>

<QueryClientProvider client={todos.queryClient}>
	<Tooltip.Provider>{@render children()}</Tooltip.Provider>
</QueryClientProvider>
