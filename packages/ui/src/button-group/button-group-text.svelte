<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		child,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		child?: Snippet<[{ props: Record<string, unknown> }]>;
	} = $props();

	const mergedProps = $derived({
		...restProps,
		class: cn(
			"bg-muted gap-2 rounded-md border px-2.5 text-sm font-medium shadow-xs [&_svg:not([class*='size-'])]:size-4 flex items-center [&_svg]:pointer-events-none",
			className,
		),
	});
</script>

{#if child}
	{@render child({ props: mergedProps })}
{:else}
	<div bind:this={ref} {...mergedProps}>{@render mergedProps.children?.()}</div>
{/if}
