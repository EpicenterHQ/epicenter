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
	data-slot="field-title"
	class={cn(
		'gap-2 text-sm leading-snug font-medium group-data-[disabled=true]/field:opacity-50 flex w-fit items-center leading-snug',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
