<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	export const fieldVariants = tv({
		base: 'data-[invalid=true]:text-destructive gap-3 group/field flex w-full',
		variants: {
			orientation: {
				vertical: 'flex-col [&>*]:w-full [&>.sr-only]:w-auto',
				horizontal: [
					'flex-row items-center',
					'[&>[data-slot=field-label]]:flex-auto',
					'has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px has-[>[data-slot=field-content]]:items-start',
				],
				responsive: [
					'@md/field-group:flex-row @md/field-group:items-center @md/field-group:[&>*]:w-auto flex-col [&>*]:w-full [&>.sr-only]:w-auto',
					'@md/field-group:[&>[data-slot=field-label]]:flex-auto',
					'@md/field-group:has-[>[data-slot=field-content]]:items-start @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px',
				],
			},
		},
		defaultVariants: {
			orientation: 'vertical',
		},
	});

	export type FieldOrientation = VariantProps<
		typeof fieldVariants
	>['orientation'];
</script>

<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		orientation = 'vertical',
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		orientation?: FieldOrientation;
	} = $props();
</script>

<div
	bind:this={ref}
	role="group"
	data-slot="field"
	data-orientation={orientation}
	class={cn(fieldVariants({ orientation }), className)}
	{...restProps}
>
	{@render children?.()}
</div>
