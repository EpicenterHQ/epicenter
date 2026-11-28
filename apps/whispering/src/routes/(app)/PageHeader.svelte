<!--
	The top of a page: its name, large, and one line under it saying what
	the page is for. `children` sits at the right, for the page's one action.
-->
<script lang="ts">
	import * as SectionHeader from '@epicenter/ui/section-header';
	import type { Snippet } from 'svelte';

	let {
		title,
		description,
		children,
	}: { title: string; description: string; children?: Snippet } = $props();
</script>

<div class="flex flex-wrap items-end justify-between gap-4">
	<SectionHeader.Root>
		<SectionHeader.Title level={1} class="text-3xl font-bold tracking-tight">{title}</SectionHeader.Title>
		<SectionHeader.Description>{description}</SectionHeader.Description>
	</SectionHeader.Root>
	{@render children?.()}
</div>
