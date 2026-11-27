<!--
	The strip at the top of any screen but Home while a take starts, runs or
	saves: a clock, the microphone's live level, and Stop. When the
	microphone has sent no sound for a few seconds, it says so, so a muted
	microphone shows up during the take rather than in an empty transcript.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { getDictation } from '#lib/dictation-view.ts';
	import Elapsed from '../Elapsed.svelte';
	import LevelMeter from '../LevelMeter.svelte';

	const dictation = getDictation();
	const take = $derived(dictation.take());
</script>

<div class="flex items-center gap-3 border-b bg-destructive/10 px-4 py-2 text-sm" role="status">
	{#if take.kind === 'recording'}
		<span class="size-2.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden="true"></span>
		<Elapsed since={take.startedAt} class="shrink-0 font-medium" />
		{#if dictation.silent()}
			<span class="min-w-0 flex-1 truncate text-destructive">No sound from the microphone. Is it muted?</span>
		{:else}
			<LevelMeter level={dictation.level()} class="flex-1 text-destructive" />
		{/if}
		<Button variant="destructive" size="sm" onclick={() => dictation.toggle()}>
			<SquareIcon class="fill-current" />
			Stop
			<kbd class="font-sans text-xs opacity-70">{dictation.keys().toggle}</kbd>
		</Button>
	{:else}
		<Spinner class="text-muted-foreground" />
		<span class="text-muted-foreground">
			{take.kind === 'starting' ? 'Starting the microphone' : 'Saving the recording'}
		</span>
	{/if}
</div>
