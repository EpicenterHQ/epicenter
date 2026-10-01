<script lang="ts">
	import type { HTMLFieldsetAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLFieldsetAttributes> = $props();
</script>

<fieldset
	bind:this={ref}
	data-slot="field-set"
	class={cn(
		'gap-6 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3 flex flex-col',
		className,
	)}
	{...restProps}
>
	{@render children?.()}
</fieldset>
