<script lang="ts">
	import type { HTMLLiAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLLiAttributes> = $props();
</script>

<li
	bind:this={ref}
	data-slot="breadcrumb-item"
	class={cn('gap-1.5 inline-flex items-center', className)}
	{...restProps}
>
	{@render children?.()}
</li>
