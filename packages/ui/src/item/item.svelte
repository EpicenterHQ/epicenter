<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	export const itemVariants = tv({
		// Honeycrisp positions note controls inside the item.
		// Keep their containing block.
		base: '[a]:hover:bg-muted rounded-md border text-sm group/item relative focus-visible:border-ring focus-visible:ring-ring/50 flex w-full flex-wrap items-center transition-colors duration-100 outline-none focus-visible:ring-[3px] [a]:transition-colors',
		variants: {
			variant: {
				default: 'border-transparent',
				outline: 'border-border',
				muted: 'bg-muted/50 border-transparent',
			},
			size: {
				default: 'gap-3.5 px-4 py-3.5',
				sm: 'gap-2.5 px-3 py-2.5',
				xs: 'gap-2 px-2.5 py-2 in-data-[slot=dropdown-menu-content]:p-0',
			},
		},
		defaultVariants: {
			variant: 'default',
			size: 'default',
		},
	});

	export type ItemSize = VariantProps<typeof itemVariants>['size'];
	export type ItemVariant = VariantProps<typeof itemVariants>['variant'];
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		child,
		variant,
		size,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		child?: Snippet<[{ props: Record<string, unknown> }]>;
		variant?: ItemVariant;
		size?: ItemSize;
	} = $props();

	const mergedProps = $derived({
		class: cn(itemVariants({ variant, size }), className),
		'data-slot': 'item',
		'data-variant': variant,
		'data-size': size,
		...restProps,
	});
</script>

{#if child}
	{@render child({ props: mergedProps })}
{:else}
	<div bind:this={ref} {...mergedProps}>{@render mergedProps.children?.()}</div>
{/if}
