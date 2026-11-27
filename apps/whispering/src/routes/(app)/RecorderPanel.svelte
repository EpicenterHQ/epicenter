<!--
	Home's recorder, as one card. The microphone is the button, centred
	under a soft light, and the voice ripples out from both sides of it
	(`VoiceWave`). Under it, one sentence says what to do now; recording,
	the light turns red and brightens with the voice, the clock takes the
	sentence's place, and a Stop button appears. A strip under that holds
	the microphone it records from on the left and, on the right, what
	became of the latest take and Hands-free; a take that went wrong gets a
	line of its own. It
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
	import { loudness } from '#lib/loudness.ts';
	import Elapsed from '../Elapsed.svelte';
	import Key from './Key.svelte';
	import MicrophoneSelect from './MicrophoneSelect.svelte';
	import VoiceWave from './VoiceWave.svelte';

	const dictation = getDictation();
	const take = $derived(dictation.take());
	const handsFree = $derived(dictation.handsFree());
	const outcome = $derived(dictation.outcome());
	const keys = $derived(dictation.keys());
	const busy = $derived(take.kind === 'starting' || take.kind === 'stopping');
	const live = $derived(take.kind === 'recording');
	const listening = $derived(take.kind === 'idle' && handsFree.kind === 'listening');
</script>

<section
	class="relative overflow-hidden rounded-xl bg-card text-card-foreground shadow-xs ring-1 ring-foreground/10"
	aria-label="Recorder"
>
	<!-- The light behind the microphone: blue at rest, red and as bright as the voice while recording. -->
	<div
		class="pointer-events-none absolute inset-x-0 top-0 h-64 transition-opacity duration-150 motion-reduce:transition-none"
		style:opacity={live ? 0.35 + loudness(dictation.level()) * 0.65 : 1}
		style:background="radial-gradient(70% 90% at 50% 0%, color-mix(in oklch, var({live
			? '--destructive'
			: '--sidebar-primary'}) {live ? 45 : 38}%, transparent), transparent)"
		aria-hidden="true"
	></div>

	<div class="relative flex flex-col items-center gap-3 px-5 pt-7 pb-6 text-center">
		<VoiceWave
			level={() => dictation.level()}
			active={live || listening}
			class={live ? 'text-destructive' : listening ? 'text-muted-foreground' : 'text-foreground/20'}
		>
			<button
				type="button"
				class="flex size-28 shrink-0 items-center justify-center rounded-full transition-transform hover:brightness-110 active:scale-95 disabled:opacity-60 motion-reduce:transition-none"
				aria-label={live ? 'Stop recording' : 'Start recording'}
				disabled={busy}
				onclick={() => dictation.toggle()}
			>
				<img src={studioMicrophone} alt="" class="size-24 drop-shadow-lg" />
			</button>
		</VoiceWave>

		<div class="flex min-h-16 flex-col items-center gap-1.5" role="status">
			{#if take.kind === 'recording'}
				<Elapsed since={take.startedAt} class="text-3xl leading-none font-semibold tabular-nums" />
				{#if dictation.silent()}
					<p class="text-sm text-destructive">No sound from the microphone. Is it muted?</p>
				{:else}
					<p class="text-sm text-muted-foreground">
						{#if take.trigger === 'hold' && keys.hold}
							Let go of <Key keys={keys.hold} /> to finish
						{:else if take.trigger === 'voice'}
							Pause when you're done, and the take ends
						{:else if keys.toggle}
							Press <Key keys={keys.toggle} /> again to finish
						{:else}
							Press Stop to finish
						{/if}
					</p>
				{/if}
			{:else if busy}
				<p class="flex items-center gap-2 text-2xl font-semibold">
					<Spinner class="size-4 text-muted-foreground" />
					{take.kind === 'starting' ? 'Starting the microphone' : 'Saving the recording'}
				</p>
			{:else if listening}
				<p class="text-2xl font-semibold">Listening</p>
				<p class="text-sm text-muted-foreground">Start talking whenever you're ready. A pause ends the take.</p>
			{:else}
				{#if keys.toggle}
					<p class="text-2xl font-semibold">Press <Key keys={keys.toggle} /> and start talking</p>
					<p class="text-sm text-muted-foreground">
						Works from any app. Press again, and the text is on your clipboard.
						{#if keys.hold}Or hold <Key keys={keys.hold} /> while you talk.{/if}
					</p>
				{:else}
					<p class="text-2xl font-semibold">Press the microphone and start talking</p>
					<p class="text-sm text-muted-foreground">
						Press it again, and the text is on your clipboard.
						{#if keys.hold}Or hold <Key keys={keys.hold} /> while you talk.{/if}
					</p>
				{/if}
			{/if}
		</div>

		{#if take.kind === 'recording' && take.trigger !== 'hold'}
			<Button
				variant="outline"
				size="sm"
				class="rounded-full"
				onclick={() => (take.trigger === 'voice' ? dictation.setHandsFree(false) : dictation.toggle())}
			>
				<SquareIcon class="fill-destructive text-destructive" />
				{take.trigger === 'voice' ? 'Stop listening' : 'Stop'}
			</Button>
		{/if}
	</div>

	<div class="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-3 py-1.5">
		<MicrophoneSelect compact disabled={take.kind !== 'idle' || handsFree.kind === 'listening'} />
		<div class="flex items-center gap-4 px-2">
			{#if outcome.kind === 'transcribing'}
				<p class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
					<Spinner /> Transcribing the last take
				</p>
			{:else if outcome.kind === 'delivered'}
				<p class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
					<CircleCheckIcon class="size-4 text-green-600 dark:text-green-400" />
					{outcome.to === 'cursor' ? 'Pasted where you were typing' : 'Copied to the clipboard'}
				</p>
			{/if}
			{#if handsFree.kind !== 'unavailable'}
				<div class="flex items-center gap-2">
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
	</div>

	<!-- A take that went wrong gets its own line: it has a reason to read, and often a link. -->
	{#if outcome.kind === 'copiedInstead' || outcome.kind === 'failed'}
		<div class="relative border-t px-5 py-2.5 text-sm">
			{#if outcome.kind === 'copiedInstead'}
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
