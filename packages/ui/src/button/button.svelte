<script lang="ts" module>
	import type {
		HTMLAnchorAttributes,
		HTMLButtonAttributes,
	} from 'svelte/elements';
	import { tv, type VariantProps } from 'tailwind-variants';
	import { cn, type WithElementRef } from '../utils.js';

	export const buttonVariants = tv({
		base: "focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-md border border-transparent bg-clip-padding text-sm font-medium focus-visible:ring-3 aria-invalid:ring-3 active:not-aria-[haspopup]:translate-y-px [&_svg:not([class*='size-'])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-all outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		variants: {
			variant: {
				default: 'bg-primary text-primary-foreground hover:bg-primary/80',
				outline: 'border-border bg-background hover:bg-muted hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 aria-expanded:bg-muted aria-expanded:text-foreground shadow-xs',
				secondary: 'bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
				ghost: 'hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 aria-expanded:bg-muted aria-expanded:text-foreground',
				destructive: 'bg-destructive/10 hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/20 text-destructive focus-visible:border-destructive/40 dark:hover:bg-destructive/30',
				link: 'text-primary underline-offset-4 hover:underline',
				'ghost-destructive': 'text-destructive hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/20',
			},
			size: {
				default: 'h-9 gap-1.5 px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
				xs: "h-6 gap-1 rounded-[min(var(--radius-md),8px)] px-2 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: 'h-8 gap-1 rounded-[min(var(--radius-md),10px)] px-2.5 in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
				lg: 'h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
				icon: 'size-9',
				'icon-xs': "size-6 rounded-[min(var(--radius-md),8px)] in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
				'icon-sm': 'size-8 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-md',
				'icon-lg': 'size-10',
			},
		},
		defaultVariants: {
			variant: 'default',
			size: 'default',
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
			/**
			 * Tooltip text to display on hover.
			 * Requires a parent `<Tooltip.Provider>` in the component tree.
			 * Wrap your app root with `<Tooltip.Provider>` to enable tooltip coordination.
			 */
			tooltip?: string;
		};
</script>

<script lang="ts">
	import { mergeProps } from 'bits-ui';
	import * as Tooltip from '../tooltip/index.js';

	let {
		class: className,
		variant = 'default',
		size = 'default',
		ref = $bindable(null),
		href = undefined,
		role,
		tabindex,
		type = 'button',
		disabled,
		children,
		tooltip,
		...restProps
	}: ButtonProps = $props();
</script>

{#snippet buttonContent(tooltipProps?: Record<string, unknown>)}
	<!--
		When this button is also the child of another trigger, e.g. Popover.Trigger,
		the outer trigger props and tooltip trigger props land on the same element.
		Plain sequential spreads replace colliding handlers and ref attachments.
		mergeProps composes handlers and function props, merges class/style, and
		preserves distinct Svelte attachment keys. Plain attributes like id/data-state
		remain last-wins.
	-->
	{@const mergedProps = tooltipProps
		? mergeProps(restProps, tooltipProps)
		: restProps}
	{#if href}
		<!-- biome-ignore lint/a11y/useValidAriaRole: conditional role is valid -->
		<a
			bind:this={ref}
			data-slot="button"
			class={cn(buttonVariants({ variant, size }), className)}
			{...mergedProps}
			href={disabled ? undefined : href}
			aria-disabled={disabled}
			role={disabled ? 'link' : role}
			tabindex={disabled ? -1 : tabindex}
			type={undefined}
		>
			{@render children?.()}
		</a>
	{:else}
		<button
			bind:this={ref}
			data-slot="button"
			class={cn(buttonVariants({ variant, size }), className)}
			{...mergedProps}
			{role}
			{tabindex}
			{type}
			{disabled}
		>
			{@render children?.()}
		</button>
	{/if}
{/snippet}

<!--
	When using the tooltip prop, this component requires a parent Tooltip.Provider.
	Wrap your app root with <Tooltip.Provider> to enable tooltip coordination.
-->
{#if tooltip}
	<Tooltip.Root>
		<Tooltip.Trigger {disabled}>
			{#snippet child({ props })}
				{@render buttonContent(props)}
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content class="max-w-xs text-center"> {tooltip} </Tooltip.Content>
	</Tooltip.Root>
{:else}
	{@render buttonContent()}
{/if}
