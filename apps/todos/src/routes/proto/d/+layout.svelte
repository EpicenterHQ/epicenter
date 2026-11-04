<!--
	PROTOTYPE option (d): the layout awaits the lazy singleton inside a
	boundary; pages import its live bindings. `{#if await ...}` holds the pages
	back until the bindings are filled.
-->
<script lang="ts">
	import { openApp } from '$lib/proto/d/app.js';

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
	{#if await openApp()}{@render children()}{/if}
</svelte:boundary>
