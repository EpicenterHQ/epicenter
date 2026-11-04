<!--
	PROTOTYPE option (c) with SvelteKit's `handleRenderingErrors`: the inner
	boundary is gone; `+error.svelte` beside this layout catches page bugs.
-->
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
	<Provide app={await untrack(openApp)}>{@render children()}</Provide>
</svelte:boundary>
