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
	data-slot="dialog-footer"
	class={cn(
		'gap-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
