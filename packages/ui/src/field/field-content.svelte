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
	data-slot="field-content"
	class={cn(
		'gap-1 group/field-content flex flex-1 flex-col leading-snug',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</div>
