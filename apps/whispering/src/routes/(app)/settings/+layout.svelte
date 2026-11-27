<!--
	Settings: the page's name, then its sections listed beside the open one
	(above it on a narrow window), each its own page so a fix can link straight to it. A section
	where dictation still needs something carries a mark.
-->
<script lang="ts">
	import { Separator } from '@epicenter/ui/separator';
	import { cn } from '@epicenter/ui/utils';
	import { page } from '$app/state';
	import { getDictation } from '#lib/dictation-view.ts';
	import PageHeader from '../PageHeader.svelte';

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

<main class="flex min-h-0 flex-1 flex-col overflow-y-auto">
	<div class="mx-auto flex w-full max-w-5xl flex-col px-6 pt-8 pb-10">
		<PageHeader title="Settings" description="How Whispering records, transcribes and hands you the text." />
		<Separator class="my-6" />
		<div class="flex flex-col gap-6 md:flex-row md:gap-10">
			<nav aria-label="Settings sections" class="flex shrink-0 gap-1 overflow-x-auto md:w-44 md:flex-col">
				{#each SECTIONS as section (section.href)}
					{@const active = page.url.pathname === section.href}
					<a
						href={section.href}
						aria-current={active ? 'page' : undefined}
						class={cn(
							'flex shrink-0 items-center justify-between gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-muted/60',
							active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
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
			<div class="flex min-w-0 max-w-2xl flex-1 flex-col gap-8">
				{@render children()}
			</div>
		</div>
	</div>
</main>
