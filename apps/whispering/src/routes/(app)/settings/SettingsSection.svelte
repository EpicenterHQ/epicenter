<!--
	One group of settings: a heading, a line about it when one helps, and
	its rows in one card with a thin line between them. A row is a
	`SettingsRow`; anything wider, like a text box, goes in a `div` with
	the same padding (`px-4 py-3.5`).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		children,
	}: {
		title: string;
		/** A line under the heading; a snippet when it needs markup. */
		description?: string | Snippet;
		children: Snippet;
	} = $props();
</script>

<section class="flex flex-col gap-3">
	<div class="flex flex-col gap-1">
		<h2 class="text-base font-semibold">{title}</h2>
		{#if typeof description === 'string'}
			<p class="text-sm text-muted-foreground">{description}</p>
		{:else if description}
			<p class="text-sm text-muted-foreground">{@render description()}</p>
		{/if}
	</div>
	<div
		class="flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-card text-card-foreground shadow-xs ring-1 ring-foreground/10"
	>
		{@render children()}
	</div>
</section>
