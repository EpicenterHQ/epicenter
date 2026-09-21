<script lang="ts" module>
	export type Side = 'top' | 'right' | 'bottom' | 'left';
</script>

<script lang="ts">
	import XIcon from '@lucide/svelte/icons/x';
	import { Dialog as SheetPrimitive } from 'bits-ui';
	import type { ComponentProps, Snippet } from 'svelte';
	import { Button } from '../button/index.js';
	import { cn, type WithoutChildrenOrChild } from '../utils.js';
	import SheetOverlay from './sheet-overlay.svelte';
	import SheetPortal from './sheet-portal.svelte';

	let {
		ref = $bindable(null),
		class: className,
		side = 'right',
		portalProps,
		children,
		...restProps
	}: WithoutChildrenOrChild<SheetPrimitive.ContentProps> & {
		portalProps?: WithoutChildrenOrChild<ComponentProps<typeof SheetPortal>>;
		side?: Side;
		children: Snippet;
	} = $props();
</script>

<SheetPortal {...portalProps}>
	<SheetOverlay />
	<SheetPrimitive.Content
		bind:ref
		data-slot="sheet-content"
		data-side={side}
		class={cn(
			'cn-sheet-content data-open:animate-in data-open:fade-in-0 data-[side=bottom]:data-open:slide-in-from-bottom-10 data-[side=left]:data-open:slide-in-from-left-10 data-[side=right]:data-open:slide-in-from-right-10 data-[side=top]:data-open:slide-in-from-top-10 data-closed:animate-out data-closed:fade-out-0 data-[side=bottom]:data-closed:slide-out-to-bottom-10 data-[side=left]:data-closed:slide-out-to-left-10 data-[side=right]:data-closed:slide-out-to-right-10 data-[side=top]:data-closed:slide-out-to-top-10',
			className,
		)}
		{...restProps}
	>
		{@render children?.()}
		<SheetPrimitive.Close data-slot="sheet-close">
			{#snippet child({ props })}
				<Button variant="ghost" class="cn-sheet-close" size="icon-sm" {...props}>
					<XIcon />
					<span class="sr-only">Close</span>
				</Button>
			{/snippet}
		</SheetPrimitive.Close>
	</SheetPrimitive.Content>
</SheetPortal>
