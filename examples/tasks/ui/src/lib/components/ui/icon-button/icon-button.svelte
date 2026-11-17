<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { ButtonProps } from '$lib/components/ui/button';

	type IconButtonProps = Omit<
		ButtonProps,
		'size' | 'children' | 'aria-label'
	> & {
		/**
		 * What the button does, in a few words: its accessible name, and the
		 * tooltip a pointer that can hover shows. A phone never shows it, so the
		 * icon must read without it.
		 */
		label: string;
		size?: 'default' | 'lg';
		/** The icon. */
		children: Snippet;
	};
</script>

<script lang="ts">
	import { mergeProps } from 'bits-ui';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';

	let {
		label,
		size = 'default',
		type = 'button',
		ref = $bindable(null),
		disabled,
		children,
		...restProps
	}: IconButtonProps = $props();

	const iconSize = $derived(size === 'default' ? 'icon' : (`icon-${size}` as const));
</script>

<!--
	Needs the app's one Tooltip.Provider above it, as every tooltip does.

	mergeProps composes the caller's handlers with the tooltip trigger's so
	neither replaces the other.
-->
<Tooltip.Root>
	<Tooltip.Trigger {disabled}>
		{#snippet child({ props })}
			<Button
				bind:ref
				{...mergeProps(restProps, props)}
				size={iconSize}
				{type}
				{disabled}
				aria-label={label}
			>
				{@render children()}
			</Button>
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content>
		{label}
	</Tooltip.Content>
</Tooltip.Root>
