<!-- What the page supplies to the views: the store's query client and the tooltip provider. -->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import { todos } from '$lib/todos.svelte.js';

	let { children }: { children: Snippet } = $props();
</script>

<QueryClientProvider client={todos.queryClient}>
	<Tooltip.Provider>{@render children()}</Tooltip.Provider>
</QueryClientProvider>
