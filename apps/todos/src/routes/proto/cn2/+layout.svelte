<!--
	PROTOTYPE: one component awaits, then sets context; nothing below reads
	it. Isolates whether setContext after an await is refused.
-->
<script lang="ts">
	import Opened from './Opened.svelte';
</script>

<svelte:boundary>
	{#snippet pending()}
		<p data-testid="pending">Opening…</p>
	{/snippet}
	{#snippet failed(error)}
		<p data-testid="recovery">recovery: {(error as Error).message}</p>
	{/snippet}
	<Opened />
</svelte:boundary>
