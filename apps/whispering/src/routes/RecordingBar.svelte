<!--
	The strip under the header while a recording starts, runs or saves: a clock,
	the microphone's live level, and Stop. When the microphone has sent no
	sound for a few seconds, it says so, so a muted or silent microphone shows
	up during the take rather than in an empty transcript.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { dictation } from '#lib/dictation.svelte.ts';
	import { formatDuration } from '#lib/feed.ts';

	/** How long the microphone may send nothing before the bar says so. */
	const QUIET_MS = 3000;

	/** The clock, ticking only while a recording runs. */
	let now = $state(Date.now());
	$effect(() => {
		if (dictation.status.kind !== 'recording') return;
		now = Date.now();
		const timer = setInterval(() => (now = Date.now()), 250);
		return () => clearInterval(timer);
	});

	/**
	 * The level as a share of the meter, on a decibel scale from -60 dB to 0,
	 * which is how loud it sounds: speech fills most of it, a quiet room a little.
	 */
	const fill = $derived(
		dictation.level > 0 ? Math.min(1, Math.max(0, 1 + (20 * Math.log10(dictation.level)) / 60)) : 0,
	);
</script>

<div class="flex items-center gap-3 border-b bg-destructive/10 px-4 py-2 text-sm" role="status">
	{#if dictation.status.kind === 'recording'}
		{@const { startedAt } = dictation.status}
		{@const quiet = now - (dictation.heardAt ?? startedAt) > QUIET_MS}
		<span class="size-2.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden="true"></span>
		<span class="shrink-0 font-medium tabular-nums">{formatDuration(Math.max(0, now - startedAt))}</span>
		{#if quiet}
			<span class="min-w-0 flex-1 truncate text-destructive">
				No sound from the microphone. Is it muted?
			</span>
		{:else}
			<div class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-destructive/15" aria-hidden="true">
				<div
					class="h-full rounded-full bg-destructive transition-[width] duration-75"
					style:width="{fill * 100}%"
				></div>
			</div>
		{/if}
		<Button variant="destructive" size="sm" onclick={() => dictation.toggle()}>
			<SquareIcon class="fill-current" />
			Stop
			<kbd class="font-sans text-xs opacity-70">⌘⇧;</kbd>
		</Button>
	{:else}
		<Spinner class="text-muted-foreground" />
		<span class="text-muted-foreground">
			{dictation.status.kind === 'starting' ? 'Starting the microphone' : 'Saving the recording'}
		</span>
	{/if}
</div>
