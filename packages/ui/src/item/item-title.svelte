<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="item-title"
	class={cn('gap-2 text-sm leading-snug font-medium underline-offset-4 min-w-0 w-fit line-clamp-1 flex items-center', className)}
	{...restProps}
>
	{@render children?.()}
</div>
