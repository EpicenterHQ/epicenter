<!--
	The floating pill: a take seen from any app, in one line. It will live in
	its own small window that never takes focus; until that exists, the
	preview page shows it. It reads only `DictationView`.

	It shows only while something is happening. Recording: the clock, the
	level, Cancel and Stop; a held key shows no buttons, since letting go
	stops it. Hands-free: listening, with Stop. Then saving, transcribing,
	cleaning up, and where the text went. A clean delivery steps aside after
	a moment, because the text is its own confirmation; a fallback or a
	failure stays until clicked or the next take, so it is not missed.
	Clicking the pill opens Whispering, at the recording when there is one.
-->
<script lang="ts">
	import { IconButton } from '@epicenter/ui/icon-button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import SquareIcon from '@lucide/svelte/icons/square';
	import XIcon from '@lucide/svelte/icons/x';
	import { getDictation } from '#lib/dictation-view.ts';
	import Elapsed from './Elapsed.svelte';
	import LevelMeter from './LevelMeter.svelte';

	/** How long a clean delivery stays before the pill steps aside. */
	const RETIRE_MS = 900;

	const dictation = getDictation();
	const take = $derived(dictation.take());
	const outcome = $derived(dictation.outcome());
	const listening = $derived(dictation.handsFree().kind === 'listening');

	/** The `at` of the last delivery whose moment has passed. */
	let retired = $state<number>();
	$effect(() => {
		if (outcome.kind !== 'delivered') return;
		const { at } = outcome;
		const timer = setTimeout(() => (retired = at), Math.max(0, at + RETIRE_MS - Date.now()));
		return () => clearTimeout(timer);
	});

	const hidden = $derived(
		take.kind === 'idle' &&
			!listening &&
			(outcome.kind === 'none' || (outcome.kind === 'delivered' && retired === outcome.at)),
	);
	/** The pill is as wide as its words, except while there is a level to show. */
	const wide = $derived(take.kind === 'recording' || (listening && take.kind === 'idle'));

	function open() {
		const id = take.kind === 'idle' && outcome.kind !== 'none' ? outcome.id : undefined;
		if (outcome.kind === 'copiedInstead' || outcome.kind === 'failed') dictation.dismiss();
		dictation.show(id);
	}
</script>

{#if !hidden}
	<div
		class={cn(
			'flex h-10 max-w-60 items-center gap-1 rounded-full border bg-popover pr-1 pl-3 text-sm text-popover-foreground shadow-lg',
			wide ? 'w-60' : 'w-fit pr-3',
		)}
		role="status"
	>
		<button
			type="button"
			class="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
			aria-label="Open Whispering"
			onclick={open}
		>
			{#if take.kind === 'recording'}
				<span class="size-2.5 shrink-0 rounded-full bg-destructive" aria-hidden="true"></span>
				<Elapsed since={take.startedAt} class="shrink-0 font-medium tabular-nums" />
				{#if dictation.silent()}
					<span class="min-w-0 flex-1 truncate text-destructive">No sound</span>
				{:else}
					<LevelMeter level={dictation.level()} class="h-4 flex-1 text-destructive" />
				{/if}
				{#if take.trigger === 'hold'}
					<span class="shrink-0 text-xs text-muted-foreground">Release to stop</span>
				{/if}
			{:else if take.kind !== 'idle'}
				<Spinner class="text-muted-foreground" />
				<span class="text-muted-foreground">{take.kind === 'starting' ? 'Starting' : 'Saving'}</span>
			{:else if listening}
				{#if outcome.kind === 'transcribing'}
					<Spinner class="size-3 shrink-0 text-muted-foreground" />
				{:else}
					<span class="size-2.5 shrink-0 rounded-full border-2 border-muted-foreground" aria-hidden="true"></span>
				{/if}
				<span class="shrink-0 text-muted-foreground">Listening</span>
				<LevelMeter level={dictation.level()} class="h-4 flex-1 text-muted-foreground" />
			{:else if outcome.kind === 'transcribing'}
				<Spinner class="text-muted-foreground" />
				<span class="text-muted-foreground">
					{dictation.isCleaning(outcome.id) ? 'Cleaning up' : 'Transcribing'}
				</span>
			{:else if outcome.kind === 'delivered'}
				<CircleCheckIcon class="size-4 shrink-0 text-muted-foreground" />
				<span>{outcome.to === 'cursor' ? 'Pasted' : 'Copied'}</span>
			{:else if outcome.kind === 'copiedInstead'}
				<CircleAlertIcon class="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
				<span class="truncate">Copied; press ⌘V to paste</span>
			{:else if outcome.kind === 'failed'}
				<CircleAlertIcon class="size-4 shrink-0 text-destructive" />
				<span class="truncate">{outcome.label}</span>
			{/if}
		</button>

		{#if take.kind === 'recording' && take.trigger !== 'hold'}
			{#if take.trigger !== 'voice'}
				<IconButton label="Cancel" size="sm" variant="ghost" class="size-7 rounded-full" onclick={() => dictation.cancel()}>
					<XIcon />
				</IconButton>
			{/if}
			<IconButton
				label={take.trigger === 'voice' ? 'Stop listening' : 'Stop'}
				size="sm"
				variant="ghost"
				class="size-7 rounded-full"
				onclick={() => (take.trigger === 'voice' ? dictation.setHandsFree(false) : dictation.toggle())}
			>
				<SquareIcon class="fill-current" />
			</IconButton>
		{:else if listening && take.kind === 'idle'}
			<IconButton label="Stop listening" size="sm" variant="ghost" class="size-7 rounded-full" onclick={() => dictation.setHandsFree(false)}>
				<SquareIcon class="fill-current" />
			</IconButton>
		{/if}
	</div>
{/if}
