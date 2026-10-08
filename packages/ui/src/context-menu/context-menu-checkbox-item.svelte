<script lang="ts">
	import { ContextMenu as ContextMenuPrimitive } from "bits-ui";
	import CheckIcon from '@lucide/svelte/icons/check';
	import { cn, type WithoutChildrenOrChild } from "../utils.js";
	import type { Snippet } from "svelte";

	let {
		ref = $bindable(null),
		checked = $bindable(false),
		indeterminate = $bindable(false),
		class: className,
		inset,
		children: childrenProp,
		closeOnSelect = false,
		...restProps
	}: WithoutChildrenOrChild<ContextMenuPrimitive.CheckboxItemProps> & {
		inset?: boolean;
		children?: Snippet;
	} = $props();
</script>

<ContextMenuPrimitive.CheckboxItem
	bind:ref
	{closeOnSelect}
	bind:checked
	bind:indeterminate
	data-slot="context-menu-checkbox-item"
	data-inset={inset}
	class={cn(
		"focus:bg-accent focus:text-accent-foreground gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm data-inset:pl-8 [&_svg:not([class*='size-'])]:size-4 relative flex cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
		className
	)}
	{...restProps}
>
	{#snippet children({ checked })}
		<span class="absolute right-2 pointer-events-none">
			{#if checked}
				<CheckIcon />
			{/if}
		</span>
		{@render childrenProp?.()}
	{/snippet}
</ContextMenuPrimitive.CheckboxItem>
