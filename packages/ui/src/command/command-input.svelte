<script lang="ts">
	import SearchIcon from '@lucide/svelte/icons/search';
	import { Command as CommandPrimitive } from 'bits-ui';
	import { cn } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		value = $bindable(''),
		children,
		...restProps
	}: CommandPrimitive.InputProps = $props();
</script>

<div
	class={cn('flex h-9 items-center gap-2 border-b ps-3', children ? 'pe-2' : 'pe-8')}
	data-slot="command-input-wrapper"
>
	<SearchIcon class="size-4 shrink-0 opacity-50" />
	<CommandPrimitive.Input
		data-slot="command-input"
		class={cn(
			'placeholder:text-muted-foreground outline-hidden flex h-10 w-full rounded-md bg-transparent py-3 text-sm disabled:cursor-not-allowed disabled:opacity-50',
			className,
		)}
		bind:ref
		{...restProps}
		bind:value
	/>
	{#if children}
		{@render children()}
	{/if}
</div>
