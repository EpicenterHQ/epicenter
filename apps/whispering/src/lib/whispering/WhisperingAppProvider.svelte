<!--
	Mounted only in the fulfilled branch of the (app) layout's boot {#await}.
	Receives the fully ready UI session, supplies its typed context
	synchronously during initialisation, and installs the session-owned
	TanStack client for the descendant tree.
-->
<script lang="ts">
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import type { Snippet } from 'svelte';
	import { setWhisperingContext } from './context';
	import type { WhisperingUiSession } from './ui-session';

	let {
		session,
		children,
	}: {
		session: WhisperingUiSession;
		children: Snippet;
	} = $props();

	// One fulfilled branch creates one immutable session/provider pair.
	/* svelte-ignore state_referenced_locally */
	setWhisperingContext({
		/* svelte-ignore state_referenced_locally */
		application: session.application,
		/* svelte-ignore state_referenced_locally */
		queries: session.queries,
	});
</script>

<QueryClientProvider client={session.queryClient}>
	{@render children()}
</QueryClientProvider>
