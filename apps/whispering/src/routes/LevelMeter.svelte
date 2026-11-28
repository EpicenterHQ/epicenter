<!--
	A microphone's level as a row of bars, taller in the middle, that rise
	together with how loud it is (`loudness.ts`): speech lifts the bars most
	of the way, a quiet room barely. The container sets the height and the color
	(`text-*`); the bars glide between readings unless motion is reduced.
-->
<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import { loudness } from '#lib/loudness.ts';

	let { level, class: className }: { level: number; class?: string } = $props();

	/** Each bar's share of the level; the fixed shape reads as a meter rather than a block. */
	const SHAPE = [0.35, 0.5, 0.68, 0.84, 0.95, 1, 0.95, 0.84, 0.68, 0.5, 0.35];
	/** A silent bar still shows, so the meter is visible before anyone speaks. */
	const FLOOR = 0.12;

	const loud = $derived(loudness(level));
</script>

<div class={cn('flex h-5 items-center justify-center gap-[3px]', className)} aria-hidden="true">
	{#each SHAPE as share, i (i)}
		<span
			class="w-[3px] rounded-full bg-current transition-[height] duration-100 ease-out motion-reduce:transition-none"
			style:height="{(FLOOR + (1 - FLOOR) * share * loud) * 100}%"
		></span>
	{/each}
</div>
