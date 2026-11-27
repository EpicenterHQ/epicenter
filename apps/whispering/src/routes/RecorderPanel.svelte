<!--
	Home's recorder. Idle, it is the microphone to press, the two ways to
	record from any app, and Hands-free. Recording, the same place holds the
	clock, the level, and Stop. Under it, what became of the latest take:
	being transcribed, delivered, or why no text came out and where to fix
	it. It reads only `DictationView`, so the preview page can show each state.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { Label } from '@epicenter/ui/label';
	import { Spinner } from '@epicenter/ui/spinner';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import SquareIcon from '@lucide/svelte/icons/square';
	import studioMicrophone from '#lib/assets/studio-microphone.png';
	import { getDictation } from '#lib/dictation-view.ts';
	import Elapsed from './Elapsed.svelte';
	import LevelMeter from './LevelMeter.svelte';

	const dictation = getDictation();
	const take = $derived(dictation.take());
	const handsFree = $derived(dictation.handsFree());
	const outcome = $derived(dictation.outcome());
	const keys = $derived(dictation.keys());
	const busy = $derived(take.kind === 'starting' || take.kind === 'stopping');

	const HEARD_BY = { button: 'Recording', shortcut: 'Recording', hold: 'Recording while held', voice: 'Heard speech' };
</script>

<section class="flex flex-col items-center gap-5 py-6 text-center" aria-label="Recorder">
	<button
		type="button"
		class="flex size-32 items-center justify-center rounded-full border bg-card shadow-sm transition-transform hover:scale-105 active:scale-95 disabled:opacity-50 motion-reduce:transition-none data-[recording=true]:border-destructive data-[recording=true]:bg-destructive/10"
		data-recording={take.kind === 'recording'}
		aria-label={take.kind === 'recording' ? 'Stop recording' : 'Start recording'}
		disabled={busy}
		onclick={() => dictation.toggle()}
	>
		{#if take.kind === 'recording'}
			<SquareIcon class="size-10 fill-destructive text-destructive" />
		{:else if busy}
			<Spinner class="size-8 text-muted-foreground" />
		{:else}
			<img src={studioMicrophone} alt="" class="size-20" />
		{/if}
	</button>

	{#if take.kind === 'recording'}
		<div class="flex w-full max-w-xs flex-col items-center gap-2" role="status">
			<p class="text-base font-medium">
				{HEARD_BY[take.trigger]} · <Elapsed since={take.startedAt} />
			</p>
			{#if dictation.silent()}
				<p class="text-sm text-destructive">No sound from the microphone. Is it muted?</p>
			{:else}
				<LevelMeter level={dictation.level()} class="w-full bg-destructive/15 text-destructive" />
			{/if}
			<Button variant="destructive" size="sm" onclick={() => dictation.toggle()}>
				<SquareIcon class="fill-current" />
				Stop
			</Button>
		</div>
	{:else if handsFree.kind === 'listening'}
		<div class="flex w-full max-w-xs flex-col items-center gap-2" role="status">
			<p class="text-base font-medium">Listening for speech</p>
			<LevelMeter level={dictation.level()} class="w-full" />
			<p class="text-sm text-muted-foreground">A take starts when you talk and ends when you pause.</p>
		</div>
	{:else}
		<dl class="grid grid-cols-[auto_auto] items-baseline gap-x-3 gap-y-1 text-sm">
			<dt class="text-right"><kbd class="font-sans font-medium">{keys.toggle}</kbd></dt>
			<dd class="text-left text-muted-foreground">starts and stops, from any app</dd>
			{#if keys.hold}
				<dt class="text-right"><kbd class="font-sans font-medium">Hold {keys.hold}</kbd></dt>
				<dd class="text-left text-muted-foreground">records while held</dd>
			{/if}
		</dl>
	{/if}

	<div class="flex flex-col items-center gap-1">
		<div class="flex items-center gap-2">
			<Checkbox
				id="hands-free"
				checked={handsFree.kind === 'listening'}
				disabled={handsFree.kind === 'unavailable'}
				onCheckedChange={(on) => dictation.setHandsFree(on === true)}
			/>
			<Label for="hands-free">Hands-free</Label>
		</div>
		{#if handsFree.kind === 'unavailable'}
			<p class="text-xs text-muted-foreground">{handsFree.why}</p>
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
			<CircleAlertIcon class="size-4 text-destructive" />
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
