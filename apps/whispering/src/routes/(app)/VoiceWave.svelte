<!--
	The voice leaving the microphone: bars on both sides of whatever sits in
	the middle, the nearest as tall as the voice is now and each one further
	out as tall as it was a moment earlier, so a word ripples outward and
	fades. While `active` is false the bars rest as a faint dotted line.

	It keeps the last second of loudness itself. With motion reduced the
	ripple stops: every bar shows the voice as it is now.
-->
<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { loudness } from '#lib/loudness.ts';

	let {
		level,
		active,
		class: className,
		children,
	}: {
		/** Reads the microphone's level now, from 0 to 1. */
		level: () => number;
		/** Whether there is a voice to draw. */
		active: boolean;
		/** The bars' color (`text-*`). */
		class?: string;
		/** What the bars spread out from. */
		children: Snippet;
	} = $props();

	/** Bars on each side. */
	const BARS = 14;
	/** How often the voice moves one bar outward. */
	const STEP_MS = 45;
	/** The shortest a bar gets, as a share of the height. */
	const FLOOR = 0.08;

	const still = new MediaQuery('prefers-reduced-motion: reduce');

	/** Loudness now, then one step ago, and so on: one reading per bar. */
	let heard = $state<number[]>(Array(BARS).fill(0));
	$effect(() => {
		if (!active) {
			heard = Array(BARS).fill(0);
			return;
		}
		const timer = setInterval(() => {
			const now = loudness(level());
			heard = still.current ? Array(BARS).fill(now) : [now, ...heard.slice(0, BARS - 1)];
		}, STEP_MS);
		return () => clearInterval(timer);
	});

	/** A bar's height: what it heard, fading with distance from the middle. */
	const height = (loud: number, i: number) =>
		active ? Math.max(FLOOR, loud * (1 - (i / BARS) * 0.75)) : FLOOR;
</script>

{#snippet wing(flip: boolean)}
	<div class={cn('flex h-12 min-w-0 flex-1 items-center gap-1', flip && 'flex-row-reverse')} aria-hidden="true">
		{#each heard as loud, i (i)}
			<span
				class="w-1 shrink-0 rounded-full bg-current transition-[height] duration-75 ease-out motion-reduce:transition-none"
				style:height="{height(loud, i) * 100}%"
			></span>
		{/each}
	</div>
{/snippet}

<div class={cn('flex w-full max-w-md items-center gap-4 overflow-hidden', className)}>
	{@render wing(true)}
	{@render children()}
	{@render wing(false)}
</div>
