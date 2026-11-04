<!-- PROTOTYPE option (c) as reviewed: await untrack(openApp), Provide, and an inner boundary for page errors. -->
<script lang="ts">
	import { untrack } from 'svelte';
	import { openApp } from '$lib/proto/cr/app.js';
	import Provide from '$lib/proto/cr/Provide.svelte';

	let { children } = $props();
</script>

<svelte:boundary>
	{#snippet pending()}
		<p data-testid="pending">Opening…</p>
	{/snippet}
	{#snippet failed(error, retry)}
		<main data-testid="recovery">
			<p>recovery: {(error as Error).message}</p>
			<button onclick={retry}>Retry</button>
		</main>
	{/snippet}
	<Provide app={await untrack(openApp)}>
		<svelte:boundary>
			{#snippet failed(error, reset)}
				<p data-testid="page-error">page error: {(error as Error).message}</p>
				<button onclick={reset}>Retry page</button>
			{/snippet}
			{@render children()}
		</svelte:boundary>
	</Provide>
</svelte:boundary>
