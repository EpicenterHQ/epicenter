<!--
	PROTOTYPE option (c), naive: one component awaits and then sets context.
	Expected: set_context_after_init.
-->
<script lang="ts">
	import Opened from './Opened.svelte';

	let { children } = $props();
</script>

<svelte:boundary>
	{#snippet pending()}
		<p data-testid="pending">Opening…</p>
	{/snippet}
	{#snippet failed(error)}
		<p data-testid="recovery">recovery: {(error as Error).message}</p>
	{/snippet}
	<Opened>{@render children()}</Opened>
</svelte:boundary>
