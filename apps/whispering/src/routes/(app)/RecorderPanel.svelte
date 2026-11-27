<!--
	Home's recorder: the microphone to press, and one sentence under it that
	says what to do now. Recording, the microphone stays and a soft red halo
	marks it live; the clock and the level take the sentence's place. Under
	it, the microphone it records from, Hands-free, and what became of the
	latest take. It reads dictation only through `DictationView`, so
	the preview page can show each state.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Label } from '@epicenter/ui/label';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import studioMicrophone from '#lib/assets/studio-microphone.png';
	import { getDictation } from '#lib/dictation-view.ts';
	import Elapsed from '../Elapsed.svelte';
	import Key from './Key.svelte';
	import LevelMeter from '../LevelMeter.svelte';
	import MicrophoneSelect from './MicrophoneSelect.svelte';

	const dictation = getDictation();
	const take = $derived(dictation.take());
	const handsFree = $derived(dictation.handsFree());
	const outcome = $derived(dictation.outcome());
	const keys = $derived(dictation.keys());
	const busy = $derived(take.kind === 'starting' || take.kind === 'stopping');
	const live = $derived(take.kind === 'recording');
</script>

<section class="flex flex-col items-center gap-6 py-8 text-center" aria-label="Recorder">
	<button
		type="button"
		class={cn(
			'flex size-44 items-center justify-center rounded-full transition hover:bg-muted/60 active:scale-95 disabled:opacity-60 motion-reduce:transition-none',
			live && 'bg-destructive/5 ring-8 ring-destructive/20 hover:bg-destructive/10',
		)}
		aria-label={live ? 'Stop recording' : 'Start recording'}
		disabled={busy}
		onclick={() => dictation.toggle()}
	>
		<img src={studioMicrophone} alt="" class="size-36 drop-shadow-lg" />
	</button>

	<div class="flex min-h-24 w-full max-w-md flex-col items-center gap-2" role="status">
		{#if take.kind === 'recording'}
			<Elapsed since={take.startedAt} class="text-3xl font-medium tabular-nums" />
			{#if dictation.silent()}
				<p class="text-sm text-destructive">No sound from the microphone. Is it muted?</p>
			{:else}
				<LevelMeter level={dictation.level()} class="h-8 text-destructive" />
			{/if}
			<p class="text-sm text-muted-foreground">
				{#if take.trigger === 'hold' && keys.hold}
					Let go of <Key keys={keys.hold} /> to finish
				{:else if take.trigger === 'voice'}
					Pause when you're done, and the take ends
				{:else}
					Press <Key keys={keys.toggle} /> or the microphone to finish
				{/if}
			</p>
		{:else if busy}
			<p class="flex items-center gap-2 text-2xl font-medium">
				<Spinner class="size-5 text-muted-foreground" />
				{take.kind === 'starting' ? 'Starting the microphone' : 'Saving the recording'}
			</p>
		{:else if handsFree.kind === 'listening'}
			<p class="text-2xl font-medium">Listening</p>
			<LevelMeter level={dictation.level()} class="h-8 text-muted-foreground" />
			<p class="text-sm text-muted-foreground">Start talking whenever you're ready. A pause ends the take.</p>
		{:else}
			<p class="text-2xl font-medium">Press <Key keys={keys.toggle} class="text-xl" /> and start talking</p>
			<p class="text-sm text-muted-foreground">Works from any app. Press again, and the text is on your clipboard.</p>
			{#if keys.hold}
				<p class="text-sm text-muted-foreground">Or hold <Key keys={keys.hold} /> while you talk.</p>
			{/if}
		{/if}
	</div>

	<div class="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
		<MicrophoneSelect compact disabled={take.kind !== 'idle'} />
		{#if handsFree.kind !== 'unavailable'}
			<div class="flex items-center gap-2">
				<Checkbox
					id="hands-free"
					checked={handsFree.kind === 'listening'}
					onCheckedChange={(on) => dictation.setHandsFree(on === true)}
				/>
				<Label for="hands-free">Hands-free</Label>
			</div>
		{/if}
	</div>

	{#if outcome.kind === 'transcribing'}
		<p class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
			<Spinner /> Transcribing the last take
		</p>
	{:else if outcome.kind === 'delivered'}
		<p class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
			<CircleCheckIcon class="size-4" />
			{outcome.to === 'cursor' ? 'Pasted where you were typing' : 'Copied to the clipboard'}
		</p>
	{:else if outcome.kind === 'copiedInstead'}
		<p class="flex items-center gap-2 text-sm" role="status">
			<CircleAlertIcon class="size-4 text-amber-600 dark:text-amber-400" />
			Copied instead: {outcome.why}
		</p>
	{:else if outcome.kind === 'failed'}
		<p class="flex flex-wrap items-center justify-center gap-2 text-sm" role="alert">
			<CircleAlertIcon class="size-4 text-destructive" />
			No text from the last take: {outcome.why}
			{#if outcome.fix}<Button variant="link" size="sm" class="h-auto p-0" href={outcome.fix.href}>{outcome.fix.label}</Button>{/if}
		</p>
	{/if}
</section>
