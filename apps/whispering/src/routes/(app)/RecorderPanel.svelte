<!--
	Home's recorder, as one card: the button that starts and stops a take,
	one sentence beside it saying what to do now, and the level at the
	right while there is one. Recording, the button turns red and shows
	Stop, and the clock takes the sentence's place. A strip under it holds
	the microphone it records from and Hands-free; a second strip, when
	there is something to say, tells what became of the latest take. It
	reads dictation only through `DictationView`, so the preview page can
	show each state.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Label } from '@epicenter/ui/label';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Switch } from '@epicenter/ui/switch';
	import { cn } from '@epicenter/ui/utils';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import SquareIcon from '@lucide/svelte/icons/square';
	import studioMicrophone from '#lib/assets/studio-microphone.png';
	import { getDictation } from '#lib/dictation-view.ts';
	import Elapsed from '../Elapsed.svelte';
	import LevelMeter from '../LevelMeter.svelte';
	import Key from './Key.svelte';
	import MicrophoneSelect from './MicrophoneSelect.svelte';

	let {
		look = 'mic',
	}: {
		/**
		 * Which design to draw, while the choice is open (the preview page shows
		 * them side by side): `mic`, the microphone picture as the button of a
		 * compact card; `mic-glow`, the same with a glow as bright as the voice;
		 * `glow`, the picture centred under a light that turns red and follows
		 * the voice; `wave`, the picture centred with the level spreading out
		 * from both sides of it.
		 */
		look?: 'mic' | 'mic-glow' | 'glow' | 'wave';
	} = $props();

	const centered = $derived(look === 'glow' || look === 'wave');

	/** How tall each bar beside the microphone may get, nearest first. */
	const WING = [1, 0.82, 0.9, 0.62, 0.7, 0.45, 0.5, 0.3, 0.34, 0.2, 0.16, 0.1];

	const dictation = getDictation();
	const take = $derived(dictation.take());
	const handsFree = $derived(dictation.handsFree());
	const outcome = $derived(dictation.outcome());
	const keys = $derived(dictation.keys());
	const busy = $derived(take.kind === 'starting' || take.kind === 'stopping');
	const live = $derived(take.kind === 'recording');
	const listening = $derived(take.kind === 'idle' && handsFree.kind === 'listening');
	/** The level as loudness from 0 to 1, on the decibel scale the level meter uses. */
	const loud = $derived.by(() => {
		const level = dictation.level();
		return level > 0 ? Math.min(1, Math.max(0, 1 + (20 * Math.log10(level)) / 60)) : 0;
	});
</script>

{#snippet stopBadge()}
	<span
		class="absolute -right-1 -bottom-1 flex size-7 items-center justify-center rounded-full bg-destructive text-white shadow-md ring-2 ring-card"
	>
		<SquareIcon class="size-3 fill-current" />
	</span>
{/snippet}

{#snippet record()}
	<button
		type="button"
		class={cn(
			'relative flex shrink-0 items-center justify-center transition-transform hover:brightness-110 active:scale-95 disabled:opacity-60 motion-reduce:transition-none',
			centered
				? 'size-28 rounded-full'
				: [
						'size-20 rounded-2xl bg-gradient-to-b from-foreground/10 to-foreground/[0.03] ring-1',
						live ? 'ring-2 ring-destructive/70' : 'ring-foreground/10',
					],
		)}
		style:box-shadow={look === 'mic-glow' && live
			? `0 0 ${12 + loud * 36}px ${loud * 10}px color-mix(in oklch, var(--destructive) ${30 + loud * 50}%, transparent)`
			: undefined}
		aria-label={live ? 'Stop recording' : 'Start recording'}
		disabled={busy}
		onclick={() => dictation.toggle()}
	>
		<img src={studioMicrophone} alt="" class={cn('drop-shadow-lg', centered ? 'size-24' : 'size-14')} />
		{#if live && !centered}{@render stopBadge()}{/if}
	</button>
{/snippet}

<!-- Bars that fall away from the microphone, as tall as the voice is loud. -->
{#snippet wing(flip: boolean)}
	<div
		class={cn(
			'flex h-12 flex-1 items-center gap-1',
			flip ? 'flex-row-reverse' : 'flex-row',
			live ? 'text-destructive' : listening ? 'text-muted-foreground' : 'text-foreground/20',
		)}
		aria-hidden="true"
	>
		{#each WING as share, i (i)}
			<span
				class="w-1 rounded-full bg-current transition-[height] duration-100 ease-out motion-reduce:transition-none"
				style:height="{live || listening ? Math.max(8, share * loud * 100) : 8}%"
			></span>
		{/each}
	</div>
{/snippet}

{#snippet status()}
	{#if take.kind === 'recording'}
		<Elapsed
			since={take.startedAt}
			class={cn('leading-none font-semibold tabular-nums', centered ? 'text-3xl' : 'text-2xl')}
		/>
		{#if dictation.silent()}
			<p class="text-sm text-destructive">No sound from the microphone. Is it muted?</p>
		{:else}
			<p class="text-sm text-muted-foreground">
				{#if take.trigger === 'hold' && keys.hold}
					Let go of <Key keys={keys.hold} /> to finish
				{:else if take.trigger === 'voice'}
					Pause when you're done, and the take ends
				{:else}
					Press <Key keys={keys.toggle} /> or the button to finish
				{/if}
			</p>
		{/if}
	{:else if busy}
		<p class={cn('flex items-center gap-2 font-semibold', centered ? 'text-2xl' : 'text-lg')}>
			<Spinner class="size-4 text-muted-foreground" />
			{take.kind === 'starting' ? 'Starting the microphone' : 'Saving the recording'}
		</p>
	{:else if listening}
		<p class={cn('font-semibold', centered ? 'text-2xl' : 'text-lg')}>Listening</p>
		<p class="text-sm text-muted-foreground">Start talking whenever you're ready. A pause ends the take.</p>
	{:else}
		<p class={cn('font-semibold', centered ? 'text-2xl' : 'text-lg')}>
			Press <Key keys={keys.toggle} /> and start talking
		</p>
		<p class="text-sm text-muted-foreground">
			Works from any app. Press again, and the text is on your clipboard.
			{#if keys.hold}Or hold <Key keys={keys.hold} /> while you talk.{/if}
		</p>
	{/if}
{/snippet}

<section
	class={cn(
		'relative overflow-hidden rounded-xl bg-card text-card-foreground shadow-xs ring-1 ring-foreground/10 transition-shadow',
		live && !centered && 'shadow-md ring-destructive/40',
	)}
	aria-label="Recorder"
>
	{#if centered}
		<!-- The light behind the microphone: blue at rest, red and as bright as the voice while recording. -->
		<div
			class="pointer-events-none absolute inset-x-0 top-0 h-64 transition-opacity duration-150 motion-reduce:transition-none"
			style:opacity={live ? 0.35 + loud * 0.65 : 1}
			style:background="radial-gradient(70% 90% at 50% 0%, color-mix(in oklch, var({live
				? '--destructive'
				: '--sidebar-primary'}) {live ? 45 : 38}%, transparent), transparent)"
			aria-hidden="true"
		></div>
		<div class="relative flex flex-col items-center gap-3 px-5 pt-7 pb-6 text-center">
			{#if look === 'wave'}
				<div class="flex w-full max-w-md items-center gap-4">
					{@render wing(true)}
					{@render record()}
					{@render wing(false)}
				</div>
			{:else}
				{@render record()}
			{/if}
			<div class="flex min-h-16 flex-col items-center gap-1.5" role="status">{@render status()}</div>
			{#if look === 'glow' && ((live && !dictation.silent()) || listening)}
				<LevelMeter
					level={dictation.level()}
					class={cn('h-8 w-40', live ? 'text-destructive' : 'text-muted-foreground')}
				/>
			{/if}
			{#if live && take.kind === 'recording' && take.trigger !== 'hold'}
				<Button variant="outline" size="sm" class="rounded-full" onclick={() => dictation.toggle()}>
					<SquareIcon class="fill-destructive text-destructive" /> Stop
				</Button>
			{/if}
		</div>
	{:else}
		<div class="flex items-center gap-5 p-5">
			{@render record()}
			<div class="flex min-w-0 flex-1 flex-col gap-1" role="status">{@render status()}</div>
			{#if (live && !dictation.silent()) || listening}
				<LevelMeter
					level={dictation.level()}
					class={cn('hidden h-8 w-28 shrink-0 sm:flex', live ? 'text-destructive' : 'text-muted-foreground')}
				/>
			{/if}
		</div>
	{/if}

	<div class="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-3 py-1.5">
		<MicrophoneSelect compact disabled={take.kind !== 'idle'} />
		{#if handsFree.kind !== 'unavailable'}
			<div class="flex items-center gap-2 px-2">
				<Label for="hands-free" class="font-normal text-muted-foreground">Hands-free</Label>
				<Switch
					id="hands-free"
					size="sm"
					checked={handsFree.kind === 'listening'}
					onCheckedChange={(on) => dictation.setHandsFree(on)}
				/>
			</div>
		{/if}
	</div>

	{#if outcome.kind !== 'none'}
		<div class="border-t px-5 py-2.5 text-sm">
			{#if outcome.kind === 'transcribing'}
				<p class="flex items-center gap-2 text-muted-foreground" role="status">
					<Spinner /> Transcribing the last take
				</p>
			{:else if outcome.kind === 'delivered'}
				<p class="flex items-center gap-2 text-muted-foreground" role="status">
					<CircleCheckIcon class="size-4 text-green-600 dark:text-green-400" />
					{outcome.to === 'cursor' ? 'Pasted where you were typing' : 'Copied to the clipboard'}
				</p>
			{:else if outcome.kind === 'copiedInstead'}
				<p class="flex items-center gap-2" role="status">
					<CircleAlertIcon class="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
					Copied instead: {outcome.why}
				</p>
			{:else}
				<p class="flex flex-wrap items-center gap-2" role="alert">
					<CircleAlertIcon class="size-4 shrink-0 text-destructive" />
					No text from the last take: {outcome.why}
					{#if outcome.fix}<Button variant="link" size="sm" class="h-auto p-0" href={outcome.fix.href}>{outcome.fix.label}</Button>{/if}
				</p>
			{/if}
		</div>
	{/if}
</section>
