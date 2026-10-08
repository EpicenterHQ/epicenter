<script lang="ts">
	import { Avatar as AvatarPrimitive } from 'bits-ui';
	import { cn } from '../utils.js';

	let {
		ref = $bindable(null),
		loadingStatus = $bindable('loading'),
		class: className,
		...restProps
	}: AvatarPrimitive.RootProps = $props();
</script>

<AvatarPrimitive.Root
	bind:ref
	bind:loadingStatus
	data-slot="avatar"
	class={cn(
		'size-8 rounded-full after:rounded-full data-[size=lg]:size-10 data-[size=sm]:size-6 after:border-border group/avatar relative flex shrink-0 select-none after:absolute after:inset-0 after:border after:mix-blend-darken dark:after:mix-blend-lighten',
		className,
	)}
	{...restProps}
/>
