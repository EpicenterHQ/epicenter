<!--
	The floating pill: a take seen from any app, in one line. It will live in
	its own small window that never takes focus; until that exists, the
	preview page shows it. It reads only `DictationView`.

	Recording: the clock, the level, Cancel and Stop. Hands-free: listening.
	Then transcribing, and where the text went, which shows for a moment;
	a fallback or a failure stays until clicked, so it is not missed.
-->
<script lang="ts">
	import { IconButton } from '@epicenter/ui/icon-button';
	import { Spinner } from '@epicenter/ui/spinner';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { getDictation } from '#lib/dictation-view.ts';
	import Elapsed from './Elapsed.svelte';
	import LevelMeter from './LevelMeter.svelte';

	const dictation = getDictation();
	const take = $derived(dictation.take());
	const outcome = $derived(dictation.outcome());
	const listening = $derived(dictation.handsFree().kind === 'listening');
</script>

<div
	class="flex h-10 w-60 items-center gap-2 rounded-full border bg-popover px-3 text-sm text-popover-foreground shadow-lg"
	role="status"
>
	{#if take.kind === 'recording'}
		<span class="size-2.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden="true"></span>
		<Elapsed since={take.startedAt} class="shrink-0 font-medium" />
		{#if dictation.silent()}
			<span class="min-w-0 flex-1 truncate text-destructive">No sound</span>
		{:else}
			<LevelMeter level={dictation.level()} class="flex-1 text-destructive" />
		{/if}
		<IconButton label="Stop" size="sm" variant="ghost" class="-mr-2 rounded-full" onclick={() => dictation.toggle()}>
			<SquareIcon class="fill-current" />
		</IconButton>
	{:else if take.kind !== 'idle'}
		<Spinner class="text-muted-foreground" />
		<span class="text-muted-foreground">{take.kind === 'starting' ? 'Starting' : 'Saving'}</span>
	{:else if outcome.kind === 'transcribing'}
		<Spinner class="text-muted-foreground" />
		<span class="text-muted-foreground">Transcribing</span>
	{:else if outcome.kind === 'delivered'}
		<CircleCheckIcon class="size-4 text-muted-foreground" />
		<span>{outcome.to === 'cursor' ? 'Pasted' : 'Copied'}</span>
	{:else if outcome.kind === 'copiedInstead'}
		<CircleAlertIcon class="size-4 shrink-0 text-destructive" />
		<span class="truncate">Copied; paste could not land</span>
	{:else if outcome.kind === 'failed'}
		<CircleAlertIcon class="size-4 shrink-0 text-destructive" />
		<span class="truncate">{outcome.why}</span>
	{:else if listening}
		<span class="size-2.5 shrink-0 rounded-full border-2 border-muted-foreground" aria-hidden="true"></span>
		<span class="shrink-0 text-muted-foreground">Listening</span>
		<LevelMeter level={dictation.level()} class="flex-1 text-muted-foreground" />
	{:else}
		<span class="text-muted-foreground">Ready</span>
	{/if}
</div>
