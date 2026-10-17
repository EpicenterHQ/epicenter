<!--
	One named row in `StatusPopover`'s details. The popover renders its status
	lines with it; an app adds its own rows (a folder path, recent versions) as
	children of the popover. Attributes go on the value (`<dd>`).

	```svelte
	<StatusRow name="Folder" class="font-mono text-xs break-all" data-testid="status-folder">
		{location}
	</StatusRow>
	```
-->
<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		name,
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLElement> & {
		/** What the row reports, as the person reads it. */
		name: string;
		children: Snippet;
	} = $props();
</script>

<div class="grid grid-cols-[5.5rem_1fr] gap-x-3 px-3 py-2">
	<dt class="text-xs text-muted-foreground">{name}</dt>
	<dd class={cn('min-w-0', className)} {...rest}>{@render children()}</dd>
</div>
