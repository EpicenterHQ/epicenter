<!-- PROTOTYPE option (r): the recommended root layout. -->
<script lang="ts">
	import { openApp, setApp } from '$lib/proto/r/app.js';
	import Provide from '$lib/proto/r/Provide.svelte';

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
	<Provide value={await openApp()} set={setApp}>{@render children()}</Provide>
</svelte:boundary>
