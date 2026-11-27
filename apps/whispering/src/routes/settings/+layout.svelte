<!--
	Settings: its sections listed beside the open one (above it on a narrow
	window), each its own page so a fix can link straight to it. A section
	where dictation still needs something carries a mark.
-->
<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import { page } from '$app/state';
	import { getDictation } from '#lib/dictation-view.ts';

	let { children } = $props();

	const dictation = getDictation();

	const SECTIONS = [
		{ label: 'Transcription', href: '/settings/transcription' },
		{ label: 'Microphone', href: '/settings/microphone' },
		{ label: 'Shortcuts', href: '/settings/shortcuts' },
		{ label: 'Output', href: '/settings/output' },
		{ label: 'Clean up', href: '/settings/cleanup' },
		{ label: 'Storage', href: '/settings/storage' },
	];

	const marked = $derived(new Set(dictation.needs().map((need) => need.fix.href)));
</script>

<main class="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row">
	<nav
		aria-label="Settings sections"
		class="flex shrink-0 gap-1 overflow-x-auto border-b p-2 md:w-48 md:flex-col md:border-r md:border-b-0 md:p-3"
	>
		<h1 class="hidden px-2 pb-2 text-lg font-semibold md:block">Settings</h1>
		{#each SECTIONS as section (section.href)}
			{@const active = page.url.pathname === section.href}
			<a
				href={section.href}
				aria-current={active ? 'page' : undefined}
				class={cn(
					'flex shrink-0 items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted',
					active ? 'bg-muted font-medium' : 'text-muted-foreground',
				)}
			>
				{section.label}
				{#if marked.has(section.href)}
					<span class="font-semibold text-destructive" aria-hidden="true">!</span>
					<span class="sr-only">(needs attention)</span>
				{/if}
			</a>
		{/each}
	</nav>
	<div class="min-w-0 flex-1 md:overflow-y-auto">
		<div class="mx-auto flex w-full max-w-xl flex-col gap-10 p-6">
			{@render children()}
		</div>
	</div>
</main>
