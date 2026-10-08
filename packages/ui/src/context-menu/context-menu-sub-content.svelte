<script lang="ts">
	import { ContextMenu as ContextMenuPrimitive } from "bits-ui";
	import { cn, type WithoutChildrenOrChild } from "../utils.js";

	let {
		ref = $bindable(null),
		class: className,
		align = "start",
		alignOffset = -3,
		portalProps,
		...restProps
	}: ContextMenuPrimitive.SubContentProps & {
		portalProps?: WithoutChildrenOrChild<ContextMenuPrimitive.PortalProps>;
	} = $props();
</script>

<ContextMenuPrimitive.Portal {...portalProps}>
	<ContextMenuPrimitive.SubContent
		bind:ref
		data-slot="context-menu-sub-content"
		{align}
		{alignOffset}
		class={cn(
			"data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 bg-popover text-popover-foreground min-w-32 rounded-md border p-1 shadow-lg duration-100 z-50 origin-(--bits-context-menu-content-transform-origin) overflow-hidden",
			className
		)}
		{...restProps}
	/>
</ContextMenuPrimitive.Portal>
