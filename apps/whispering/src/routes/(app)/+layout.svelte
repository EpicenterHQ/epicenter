<!--
	Whispering's root, which decides the store (decision 78): the variant's
	`Startup` (`#platform/root`) opens it before any page renders, under this
	boundary's spinner, and hands its client to the app. The web build's is
	this browser's storage for good, with no account needed and nothing ever
	uploaded (ADR-0700); the desktop window's is the folder Whispering keeps
	its recordings in. The sign-in callback is outside this group.
-->
<script lang="ts">
	import { Startup } from '#platform/root';
	import { Loading } from '@epicenter/ui/loading';
	import type { Snippet } from 'svelte';
	import WhisperingApp from '../components/WhisperingApp.svelte';

	// Named apart from `Startup`'s own `children`, the app over its store.
	let { children: page }: { children: Snippet } = $props();
</script>

<svelte:boundary>
	{#snippet pending()}
		<Loading class="h-dvh" />
	{/snippet}
	<Startup>
		{#snippet children(client, files)}
			<WhisperingApp {client} {files}>{@render page()}</WhisperingApp>
		{/snippet}
	</Startup>
</svelte:boundary>
