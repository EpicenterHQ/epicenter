<script lang="ts">
	import { toast } from 'svelte-sonner';
	import { Toaster } from '$lib/components/ui/sonner';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import {
		MutationCache,
		QueryCache,
		QueryClient,
		QueryClientProvider,
	} from '@tanstack/svelte-query';
	import { ModeWatcher } from 'mode-watcher';
	import { currentRoute } from '$lib/router.svelte.js';
	import List from './pages/List.svelte';
	import TaskEditor from '$lib/components/TaskEditor.svelte';

	const route = $derived(currentRoute());

	const queryClient = new QueryClient({
		queryCache: new QueryCache({
			onError: (error, query) => {
				if (query.state.data === undefined || error.name === 'Missing') return;
				toast.error('Could not refresh', {
					id: 'refresh',
					description: error.message,
					action: {
						label: 'Refresh',
						onClick: () => {
							void queryClient.refetchQueries({ queryKey: query.queryKey, exact: true });
						},
					},
				});
			},
		}),
		defaultOptions: { queries: { retry: false } },
		mutationCache: new MutationCache({
			onSettled: (_data, _error, _variables, _result, _mutation, { client }) =>
				client.invalidateQueries(),
		}),
	});
</script>

<Tooltip.Provider>
	<QueryClientProvider client={queryClient}>
		{#if route.length === 2 && route[0] === 'tasks'}
			{#key route[1]}<TaskEditor id={route[1]} />{/key}
		{:else}
			<List />
		{/if}
	</QueryClientProvider>

	<Toaster
		position="bottom-center"
		offset={{ bottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
		mobileOffset={{ bottom: 'calc(env(safe-area-inset-bottom) + 16px)' }}
	/>
	<ModeWatcher />
</Tooltip.Provider>
