<!--
	PROTOTYPE option (c): the layout awaits the world inside a boundary and
	provides it by context. Retry is the boundary's reset.
-->
<script lang="ts">
	import Provide from '$lib/proto/c/Provide.svelte';
	import { openWorld } from '$lib/proto/open.js';

	let { children } = $props();
</script>

<svelte:boundary>
	{#snippet pending()}
		<p data-testid="pending">Opening…</p>
	{/snippet}
	{#snippet failed(error, reset)}
		<main data-testid="recovery">
			<p>recovery: {(error as Error).message}</p>
			<button onclick={reset}>Retry</button>
		</main>
	{/snippet}
	<Provide world={await openWorld('c')}>{@render children()}</Provide>
</svelte:boundary>
