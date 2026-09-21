<!--
	Installed from @ieedan/shadcn-svelte-extras
-->

<script lang="ts">
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import { scale } from 'svelte/transition';
	import { Button } from '../button/index.js';
	import { UseAutoScroll } from '../hooks/use-auto-scroll.svelte.js';
	import { cn } from '../utils.js';

	import type { ChatListProps } from './types';

	let {
		children,
		class: className,
		ref = $bindable(null),
		...rest
	}: ChatListProps = $props();

	const autoScroll = new UseAutoScroll();
</script>

<div class="relative h-full">
	<div
		{...rest}
		bind:this={ref}
		class={cn(
			'no-scrollbar flex h-full w-full flex-col gap-4 overflow-y-auto p-4',
			className,
		)}
		bind:this={autoScroll.ref}
	>
		{@render children?.()}
	</div>
	{#if !autoScroll.isAtBottom}
		<div
			in:scale={{ delay: 250, duration: 100, start: 0.85 }}
			out:scale={{ duration: 100, start: 0.85 }}
		>
			<Button
				aria-label="Scroll to latest message"
				onclick={() => autoScroll.scrollToBottom()}
				variant="outline"
				size="icon"
				class="absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 transform rounded-full shadow-md"
			>
				<ArrowDownIcon />
			</Button>
		</div>
	{/if}
</div>
