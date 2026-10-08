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
	data-slot="item-content"
	class={cn(
		'gap-1 group-data-[size=xs]/item:gap-0 min-w-0 flex flex-1 flex-col [&+[data-slot=item-content]]:flex-none',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
