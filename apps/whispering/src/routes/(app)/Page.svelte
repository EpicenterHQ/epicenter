<!--
	A page that scrolls as one column: its name and the line under it, then
	its content, centred and no wider than `class` says (`max-w-3xl` unless
	told). The window's frame (`+layout.svelte`) is exactly the window and
	never scrolls; this is the one element on such a page that does, so a
	page has one scrollbar. Recordings does not use it: its list and its
	reading pane each scroll on their own.
-->
<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import type { Snippet } from 'svelte';
	import PageHeader from './PageHeader.svelte';

	let {
		title,
		description,
		class: className,
		children,
	}: { title: string; description: string; class?: string; children: Snippet } = $props();
</script>

<div class="min-h-0 flex-1 overflow-y-auto">
	<div class={cn('mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pt-8 pb-10', className)}>
		<PageHeader {title} {description} />
		{@render children()}
	</div>
</div>
