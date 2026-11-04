<!--
	PROTOTYPE option (d), naive: the await is a sibling of the pages, not
	their guard. Do the pages run before the bindings are filled?
-->
<script lang="ts">
	import { openApp } from '$lib/proto/d/app.js';

	let { children } = $props();
</script>

<svelte:boundary>
	{#snippet pending()}
		<p data-testid="pending">Opening…</p>
	{/snippet}
	{#snippet failed(error)}
		<p data-testid="recovery">recovery: {(error as Error).message}</p>
	{/snippet}
	{await openApp()}
	{@render children()}
</svelte:boundary>
