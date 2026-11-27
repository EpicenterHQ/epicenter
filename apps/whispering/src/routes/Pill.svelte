<!--
	The floating pill: a take seen from any app, in one line. It will live in
	its own small window that never takes focus; until that exists, the
	preview page shows it. It reads only `DictationView`.

	It shows only while something is happening. Recording: the clock, the
	level, Cancel and Stop; a held key shows "Release" and no buttons, since letting go
	stops it. Hands-free: listening, with Stop. Then saving, transcribing,
	cleaning up, and where the text went. A clean delivery steps aside after
	a moment, because the text is its own confirmation; a fallback or a
	failure stays until clicked or the next take, so it is not missed.
	Clicking the pill opens Whispering: at the microphone settings while it
	says No sound, else at the take's recording, else at Home.

	It is dark glass in either theme, because it floats over whatever app is
	in front and must read on all of them. Stop is always the rightmost
	button, so the hand learns one place; Cancel sits left of it, grey where
	Stop is red. Both are plain round buttons with no tooltip, which the
	pill's small window could not hold.
-->
<script lang="ts">
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import CheckIcon from '@lucide/svelte/icons/check';
	import SquareIcon from '@lucide/svelte/icons/square';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import XIcon from '@lucide/svelte/icons/x';
	import { getDictation } from '#lib/dictation-view.ts';
	import Elapsed from './Elapsed.svelte';
	import LevelMeter from './LevelMeter.svelte';

	/** How long a clean delivery stays before the pill steps aside. */
	const RETIRE_MS = 900;

	const BUTTON =
		'flex size-6 shrink-0 items-center justify-center rounded-full transition duration-150 hover:scale-110 active:scale-95 motion-reduce:transition-none';

	let {
		onshownchange,
	}: {
		/** Hears whether the pill shows anything, so its window can hide when it does not. */
		onshownchange?: (shown: boolean) => void;
	} = $props();

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
	$effect(() => onshownchange?.(!hidden));

	/** The pill is as wide as its words, except while there is a level to show. */
	const wide = $derived(take.kind === 'recording' || (listening && take.kind === 'idle'));
	const failed = $derived(take.kind === 'idle' && !listening && outcome.kind === 'failed');

	const silent = $derived(take.kind === 'recording' && dictation.silent());

	function open() {
		if (silent) return dictation.show('/settings/microphone');
		const id = take.kind === 'idle' && outcome.kind !== 'none' ? outcome.id : undefined;
		if (outcome.kind === 'copiedInstead' || outcome.kind === 'failed') dictation.dismiss();
		dictation.show(id ? `/recordings?id=${encodeURIComponent(id)}` : '/');
	}
</script>

{#if !hidden}
	<div
		class={cn(
			'flex h-10 max-w-56 items-center gap-1.5 rounded-full border px-2.5 text-[13px] font-medium text-white/90 backdrop-blur-md select-none',
			failed ? 'border-red-500/50 bg-red-950/90' : 'border-white/10 bg-neutral-950/85',
			wide ? 'w-56' : 'w-fit pr-3.5',
		)}
		role="status"
	>
		<button
			type="button"
			class="flex h-full min-w-0 flex-1 items-center gap-2.5 text-left"
			aria-label={silent ? 'Open microphone settings' : 'Open Whispering'}
			onclick={open}
		>
			{#if take.kind === 'recording'}
				<Elapsed since={take.startedAt} class="shrink-0 pl-1 tabular-nums" />
				{#if dictation.silent()}
					<span class="min-w-0 flex-1 truncate text-red-300">No sound</span>
				{:else}
					<LevelMeter level={dictation.level()} class="h-5 flex-1 text-white/80" />
				{/if}
				{#if take.trigger === 'hold'}
					<span class="shrink-0 text-xs text-white/60">Release</span>
				{/if}
			{:else if take.kind !== 'idle'}
				<Spinner class="text-white/70" />
				<span>{take.kind === 'starting' ? 'Starting' : 'Saving'}</span>
			{:else if listening}
				{#if outcome.kind === 'transcribing'}
					<Spinner class="size-3 shrink-0 text-white/60" />
				{:else}
					<span class="size-2.5 shrink-0 rounded-full border-2 border-white/50" aria-hidden="true"></span>
				{/if}
				<span class="shrink-0 text-white/70">Listening</span>
				<LevelMeter level={dictation.level()} class="h-5 flex-1 text-white/50" />
			{:else if outcome.kind === 'transcribing'}
				<Spinner class="text-white/70" />
				<span>{dictation.isCleaning(outcome.id) ? 'Cleaning up' : 'Transcribing'}</span>
			{:else if outcome.kind === 'delivered'}
				<CheckIcon class="size-4 shrink-0 text-green-400" />
				<span>{outcome.to === 'cursor' ? 'Pasted' : 'Copied'}</span>
			{:else if outcome.kind === 'copiedInstead'}
				<CheckIcon class="size-4 shrink-0 text-amber-300" />
				<span class="truncate">Copied; press ⌘V to paste</span>
			{:else if outcome.kind === 'failed'}
				<TriangleAlertIcon class="size-4 shrink-0 text-red-300" />
				<span class="truncate">{outcome.label}</span>
			{/if}
		</button>

		{#if take.kind === 'recording' && take.trigger !== 'hold'}
			{#if take.trigger !== 'voice'}
				<button
					type="button"
					class={cn(BUTTON, 'bg-white/10 hover:bg-white/20 hover:text-white')}
					aria-label="Cancel"
					onclick={() => dictation.cancel()}
				>
					<XIcon class="size-4" />
				</button>
			{/if}
			<button
				type="button"
				class={cn(BUTTON, 'bg-red-500/60 text-white hover:bg-red-500/80')}
				aria-label={take.trigger === 'voice' ? 'Stop listening' : 'Stop'}
				onclick={() => (take.trigger === 'voice' ? dictation.setHandsFree(false) : dictation.toggle())}
			>
				<SquareIcon class="size-3.5" />
			</button>
		{:else if listening && take.kind === 'idle'}
			<button
				type="button"
				class={cn(BUTTON, 'bg-red-500/60 text-white hover:bg-red-500/80')}
				aria-label="Stop listening"
				onclick={() => dictation.setHandsFree(false)}
			>
				<SquareIcon class="size-3.5" />
			</button>
		{/if}
	</div>
{/if}
