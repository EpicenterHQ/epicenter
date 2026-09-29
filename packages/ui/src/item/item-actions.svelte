<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		showOnHover = false,
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		/** When true, actions are hidden by default and shown on hover of the parent `group/item`. */
		showOnHover?: boolean;
	} = $props();
</script>

<div
	bind:this={ref}
	data-slot="item-actions"
	class={cn(
		'gap-2 flex items-center',
		showOnHover && [
			// Overlay the right side of the item instead of taking flex space, so the
			// title gets full width when actions are hidden. Solid bg-accent masks the
			// text underneath, matching the item's hover background.
			'absolute inset-y-0 right-0 bg-accent pl-2 pr-4',
			// Fade in/out on hover of the parent group/item.
			'opacity-0 transition-opacity group-hover/item:opacity-100',
			// Pseudo-element gradient on the left edge so text fades out smoothly
			// rather than hard-clipping against the solid background.
			'before:pointer-events-none before:absolute before:inset-y-0 before:-left-4 before:w-4 before:bg-linear-to-r before:from-transparent before:to-accent',
		],
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
