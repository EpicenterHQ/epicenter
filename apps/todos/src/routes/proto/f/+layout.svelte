<!--
	PROTOTYPE option (f): the layout awaits the world's promise inside a
	boundary; each component that needs a value awaits the same promise.
	Retry makes a fresh promise, then resets the boundary.
-->
<script lang="ts">
	import { reopen, world } from '$lib/proto/f/app.js';

	let { children } = $props();
</script>

<svelte:boundary>
	{#snippet pending()}
		<p data-testid="pending">Opening…</p>
	{/snippet}
	{#snippet failed(error, reset)}
		<main data-testid="recovery">
			<p>recovery: {(error as Error).message}</p>
			<button
				onclick={() => {
					reopen();
					reset();
				}}>Retry</button
			>
		</main>
	{/snippet}
	{#if await world}
		<nav><a href="/proto/f">f one</a> <a href="/proto/f/two">f two</a></nav>
		{@render children()}
	{/if}
</svelte:boundary>
