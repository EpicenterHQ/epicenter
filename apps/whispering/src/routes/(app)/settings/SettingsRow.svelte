<!--
	One setting in a `SettingsSection`: what it is on the left, with a line
	under it when one helps, and its control on the right. On a narrow
	window a wide control drops under its label.
-->
<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import type { Snippet } from 'svelte';

	let {
		label,
		description,
		for: htmlFor,
		disabled = false,
		error,
		children,
	}: {
		label: string;
		description?: string | Snippet;
		/** The id of the control the label names. */
		for?: string;
		/** Greys the row, for a setting that cannot be changed now. */
		disabled?: boolean;
		/** What is wrong with the value, under the label. */
		error?: string;
		/** The control. */
		children?: Snippet;
	} = $props();
</script>

<div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3.5">
	<div class={cn('flex min-w-0 flex-1 basis-48 flex-col gap-0.5', disabled && 'opacity-60')}>
		<label for={htmlFor} class="text-sm font-medium">{label}</label>
		{#if typeof description === 'string'}
			<p class="text-sm text-muted-foreground">{description}</p>
		{:else if description}
			<p class="text-sm text-muted-foreground">{@render description()}</p>
		{/if}
		{#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
	</div>
	{#if children}<div class="flex shrink-0 items-center gap-2">{@render children()}</div>{/if}
</div>
