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
	import MicIcon from '@lucide/svelte/icons/mic';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { getDictation } from '#lib/dictation-view.ts';
	import Elapsed from '../Elapsed.svelte';
	import LevelMeter from '../LevelMeter.svelte';
	import Key from './Key.svelte';
	import MicrophoneSelect from './MicrophoneSelect.svelte';

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
	class={cn(
		'overflow-hidden rounded-xl bg-card text-card-foreground shadow-xs ring-1 ring-foreground/10 transition-shadow',
		live && 'shadow-md ring-destructive/40',
	)}
	aria-label="Recorder"
>
	<div class="flex items-center gap-5 p-5">
		<button
			type="button"
			class={cn(
				'flex size-16 shrink-0 items-center justify-center rounded-2xl shadow-sm transition-transform hover:brightness-110 active:scale-95 disabled:opacity-60 motion-reduce:transition-none',
				live ? 'bg-destructive text-white' : 'bg-primary text-primary-foreground',
			)}
			aria-label={live ? 'Stop recording' : 'Start recording'}
			disabled={busy}
			onclick={() => dictation.toggle()}
		>
			{#if busy}
				<Spinner class="size-6" />
			{:else if live}
				<SquareIcon class="size-6 fill-current" />
			{:else}
				<MicIcon class="size-7" />
			{/if}
		</button>

		<div class="flex min-w-0 flex-1 flex-col gap-1" role="status">
			{#if take.kind === 'recording'}
				<Elapsed since={take.startedAt} class="text-2xl leading-none font-semibold tabular-nums" />
				{#if dictation.silent()}
					<p class="text-sm text-destructive">No sound from the microphone. Is it muted?</p>
				{:else}
					<p class="text-sm text-muted-foreground">
						{#if take.trigger === 'hold' && keys.hold}
							Let go of <Key keys={keys.hold} /> to finish
						{:else if take.trigger === 'voice'}
							Pause when you're done, and the take ends
						{:else}
							Press <Key keys={keys.toggle} /> or Stop to finish
						{/if}
					</p>
				{/if}
			{:else if busy}
				<p class="text-lg font-semibold">
					{take.kind === 'starting' ? 'Starting the microphone' : 'Saving the recording'}
				</p>
			{:else if listening}
				<p class="text-lg font-semibold">Listening</p>
				<p class="text-sm text-muted-foreground">Start talking whenever you're ready. A pause ends the take.</p>
			{:else}
				<p class="text-lg font-semibold">Press <Key keys={keys.toggle} /> and start talking</p>
				<p class="text-sm text-muted-foreground">
					Works from any app. Press again, and the text is on your clipboard.
					{#if keys.hold}Or hold <Key keys={keys.hold} /> while you talk.{/if}
				</p>
			{/if}
		</div>

		{#if (live && !dictation.silent()) || listening}
			<LevelMeter
				level={dictation.level()}
				class={cn('hidden h-8 w-28 shrink-0 sm:flex', live ? 'text-destructive' : 'text-muted-foreground')}
			/>
		{/if}
	</div>

	<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-3 py-1.5">
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
