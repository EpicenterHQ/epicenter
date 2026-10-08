<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<
		HTMLAttributes<HTMLUListElement>,
		HTMLUListElement
	> = $props();
</script>

<ul
	bind:this={ref}
	data-slot="sidebar-menu"
	data-sidebar="menu"
	class={cn('gap-1 flex w-full min-w-0 flex-col', className)}
	{...restProps}
>
	{@render children?.()}
</ul>
