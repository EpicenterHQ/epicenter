<!--
	A microphone's level as a bar, on a decibel scale from -60 dB to 0, which
	is how loud it sounds: speech fills most of it, a quiet room a little.
-->
<script lang="ts">
	import { cn } from '@epicenter/ui/utils';

	let { level, class: className }: { level: number; class?: string } = $props();

	const fill = $derived(level > 0 ? Math.min(1, Math.max(0, 1 + (20 * Math.log10(level)) / 60)) : 0);
</script>

<div class={cn('h-1.5 min-w-0 overflow-hidden rounded-full bg-muted', className)} aria-hidden="true">
	<div class="h-full rounded-full bg-current transition-[width] duration-75" style:width="{fill * 100}%"></div>
</div>
