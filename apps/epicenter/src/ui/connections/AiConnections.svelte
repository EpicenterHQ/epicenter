<script lang="ts">
	import { createQuery, QueryClient, setQueryClientContext } from '@tanstack/svelte-query';
	import { onMount } from 'svelte';
	import { commands } from '../bindings.gen';
	import ConnectionList from './ConnectionList.svelte';
	import { CONNECTIONS_KEY, failureText } from './connections';

	/**
	 * Settings' AI connections (ADR-0557, ADR-0587): this computer's
	 * connections, which the `epicenter` CLI keeps in app data with each
	 * endpoint and key in the keychain, listed through the shell's
	 * `ai_key_list` and changed through `ai_key_set` and `ai_key_remove`. No
	 * folder is opened, and no key is read back.
	 */
	const queryClient = new QueryClient();
	setQueryClientContext(queryClient);
	onMount(() => {
		queryClient.mount();
		return () => queryClient.unmount();
	});

	const listing = createQuery(
		() => ({
			queryKey: CONNECTIONS_KEY,
			queryFn: async () => {
				const { data, error } = await commands.aiKeyList();
				if (error !== null) throw new Error(failureText(error));
				return data.connections;
			},
		}),
		() => queryClient,
	);
</script>

<div class="grid gap-3 border-b p-3">
	<h2 class="font-medium">AI connections</h2>
	{#if listing.error}
		<p role="alert" class="text-destructive">Could not list the connections: {listing.error.message}</p>
	{:else if listing.isPending}
		<p class="text-muted-foreground">Reading…</p>
	{:else}
		<ConnectionList connections={listing.data} />
	{/if}
</div>
