<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLParagraphElement>> = $props();
</script>

<p
	bind:this={ref}
	data-slot="field-description"
	class={cn(
		"text-muted-foreground text-left text-sm [[data-variant=legend]+&]:-mt-1.5 leading-normal font-normal group-has-data-horizontal/field:text-balance",
		'nth-last-2:-mt-1 last:mt-0',
		'[&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</p>
