<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { ButtonProps } from '../button/index.js';

	/** The sizes of a button that shows only an icon. */
	export type IconButtonSize = 'default' | 'xs' | 'sm' | 'lg';

	export type IconButtonProps = Omit<
		ButtonProps,
		'size' | 'children' | 'aria-label'
	> & {
		/**
		 * What the button does, in a few words: its accessible name, and the
		 * tooltip a pointer that can hover shows. A phone never shows it, so the
		 * icon must read without it.
		 */
		label: string;
		/** The keyboard shortcut, as a person reads it (`⌘N`), shown after the label. */
		shortcut?: string;
		size?: IconButtonSize;
		/** The icon. */
		children: Snippet;
	};
</script>

<script lang="ts">
	import { mergeProps } from 'bits-ui';
	import { Button } from '../button/index.js';
	import * as Tooltip from '../tooltip/index.js';

	let {
		label,
		shortcut,
		size = 'default',
		ref = $bindable(null),
		disabled,
		children,
		...restProps
	}: IconButtonProps = $props();

	const iconSize = $derived(size === 'default' ? 'icon' : (`icon-${size}` as const));
	/** Whether the popover or menu this button opens is open. */
	const expanded = $derived(
		restProps['aria-expanded'] === true || restProps['aria-expanded'] === 'true',
	);
	let hinting = $state(false);
</script>

<!--
	Needs the app's one Tooltip.Provider above it, as every tooltip does.

	When this button is also the child of another trigger (Popover.Trigger,
	DropdownMenu.Trigger), the outer trigger's props arrive in restProps and the
	tooltip trigger's in props. mergeProps composes their handlers and
	attachments; plain spreads in sequence would let one replace the other.

	While what it opens is open, the tooltip stays shut, so it never covers the
	popover and never takes the Escape that should close it.
-->
<Tooltip.Root
	disabled={expanded}
	bind:open={() => hinting && !expanded, (next) => (hinting = next)}
>
	<Tooltip.Trigger {disabled}>
		{#snippet child({ props })}
			<Button
				bind:ref
				{...mergeProps(restProps, props)}
				size={iconSize}
				{disabled}
				aria-label={label}
			>
				{@render children()}
			</Button>
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content>
		{label}{#if shortcut}<kbd class="ml-1.5 font-sans opacity-70">{shortcut}</kbd>{/if}
	</Tooltip.Content>
</Tooltip.Root>
