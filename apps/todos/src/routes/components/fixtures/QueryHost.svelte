<!-- What the layout supplies to every page: the app's one query client and the tooltip provider. -->
<script lang="ts">
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import { queryClient } from '$lib/query.js';

	let { children }: { children: Snippet } = $props();
</script>

<QueryClientProvider client={queryClient}>
	<Tooltip.Provider>{@render children()}</Tooltip.Provider>
</QueryClientProvider>
