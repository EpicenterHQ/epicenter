<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import XIcon from '@lucide/svelte/icons/x';
	import { scale } from 'svelte/transition';
	import { Button } from '../button/index.js';
	import { UseClipboard } from '../hooks/use-clipboard.svelte.js';
	import { cn } from '../utils.js';
	import type { CopyButtonProps } from './types';

	let {
		ref = $bindable(null),
		text,
		icon,
		animationDuration = 500,
		variant = 'ghost',
		size = 'icon',
		onCopy,
		copyFn,
		class: className,
		tabindex = -1,
		children,
		...rest
	}: CopyButtonProps = $props();

	let effectiveSize = $derived(size === 'icon' && children ? 'default' : size);

	// svelte-ignore state_referenced_locally - clipboard instance created once with initial copyFn
	const clipboard = new UseClipboard({ copyFn });
</script>

<Button
	{...rest}
	bind:ref
	{variant}
	size={effectiveSize}
	{tabindex}
	class={cn('flex items-center gap-2', className)}
	type="button"
	name="copy"
	onclick={async () => {
		const status = await clipboard.copy(text);

		onCopy?.(status);
	}}
>
	{#if clipboard.status === 'success'}
		<div in:scale={{ duration: animationDuration, start: 0.85 }}>
			<CheckIcon tabindex={-1} />
			<span class="sr-only">Copied</span>
		</div>
	{:else if clipboard.status === 'failure'}
		<div in:scale={{ duration: animationDuration, start: 0.85 }}>
			<XIcon tabindex={-1} />
			<span class="sr-only">Failed to copy</span>
		</div>
	{:else}
		<div in:scale={{ duration: animationDuration, start: 0.85 }}>
			{#if icon}
				{@render icon()}
			{:else}
				<CopyIcon tabindex={-1} />
			{/if}
			<span class="sr-only">Copy</span>
		</div>
	{/if}
	{@render children?.()}
</Button>
