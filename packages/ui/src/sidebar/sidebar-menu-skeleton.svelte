<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { Skeleton } from '../skeleton/index.js';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		showIcon = false,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> & {
		showIcon?: boolean;
	} = $props();

	// Random width between 50% and 90%
	const width = `${Math.floor(Math.random() * 40) + 50}%`;
</script>

<div
	bind:this={ref}
	data-slot="sidebar-menu-skeleton"
	data-sidebar="menu-skeleton"
	class={cn('h-8 gap-2 rounded-md px-2 flex items-center', className)}
	{...restProps}
>
	{#if showIcon}
		<Skeleton
			class="size-4 rounded-md"
			data-sidebar="menu-skeleton-icon"
		/>
	{/if}
	<Skeleton
		class="h-4 max-w-(--skeleton-width) flex-1"
		data-sidebar="menu-skeleton-text"
		style="--skeleton-width: {width};"
	/>
	{@render children?.()}
</div>
