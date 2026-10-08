<script lang="ts">
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef, type WithoutChildren } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildren<
		WithElementRef<HTMLAttributes<HTMLSpanElement>>
	> = $props();
</script>

<span
	bind:this={ref}
	data-slot="breadcrumb-ellipsis"
	role="presentation"
	aria-hidden="true"
	class={cn('size-5 [&>svg]:size-4 flex items-center justify-center', className)}
	{...restProps}
>
	<EllipsisIcon class="size-4" />
	<span class="sr-only">More</span>
</span>
