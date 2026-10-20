<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Spinner } from '@epicenter/ui/spinner';
	import { cn } from '@epicenter/ui/utils';
	import SquareIcon from '@lucide/svelte/icons/square';
	import type { Library } from '$lib/library.svelte.js';
	import MicrophoneControl from './MicrophoneControl.svelte';
	import PostProcessingControl from './PostProcessingControl.svelte';
	import RecorderClock from './RecorderClock.svelte';
	import TranscriptionControl from './TranscriptionControl.svelte';

	/**
	 * The home page's recorder: the microphone is the control that starts and
	 * stops, with one line under it for what is happening. Three small controls
	 * sit at its lower right on wide windows and below the hint on narrow ones.
	 * Fixture mode adds its warning under them.
	 */
	let { library }: { library: Library } = $props();

	const active = $derived(library.recorder.phase === 'recording');
	const pending = $derived(library.recorder.phase === 'starting' || library.recorder.phase === 'stopping');
	const label = $derived(
		{ idle: 'Start recording', starting: 'Starting…', recording: 'Stop recording', stopping: 'Finishing…' }[library.recorder.phase],
	);

	/**
	 * Which of the three option popovers is open. One value, so opening one
	 * closes the one before it: nothing is left open behind another, and the
	 * microphone popover's test or enabling ends when it stops being the one.
	 */
	type Option = 'microphone' | 'transcription' | 'post-processing';
	let openOption = $state<Option>();
	function setOpen(option: Option, open: boolean) {
		if (open) openOption = option;
		else if (openOption === option) openOption = undefined;
	}

	// The button is disabled while pending, which drops keyboard focus to the
	// page. Give it back when the press came from the focused microphone.
	let mic = $state<HTMLElement | null>(null);
	let returnFocus = false;
	function toggle() {
		openOption = undefined;
		returnFocus = document.activeElement === mic;
		void (active ? library.stopRecording() : library.startRecording());
	}
	$effect(() => {
		if (pending || !returnFocus) return;
		returnFocus = false;
		// Only when focus went nowhere: someone who moved elsewhere keeps their place.
		if (document.activeElement === document.body) mic?.focus({ preventScroll: true });
	});
</script>

<!--
	--mic is the microphone's size at this width. The button, the stop mark, and how far the options tuck in are all taken from it.
	With enough room the grid's outer columns are equal, so the options sit to the right without moving the microphone off center.
-->
<div class="grid w-full justify-items-center gap-y-4 [--mic:6rem] @sm/recorder:[--mic:7rem] @md/recorder:grid-cols-[1fr_auto_1fr] @md/recorder:[--mic:8rem]">
	<!-- The button keeps one size in every phase, so nothing under it moves. -->
	<Button
		bind:ref={mic}
		variant="ghost"
		class="relative size-[calc(var(--mic)*1.25)] rounded-full p-0 hover:bg-transparent disabled:opacity-100 @md/recorder:col-start-2 dark:hover:bg-transparent"
		aria-label={label}
		aria-pressed={active}
		aria-busy={pending}
		disabled={pending}
		onclick={toggle}
		data-testid={active ? 'stop-recording' : 'start-recording'}
	>
		{#if active}
			<span class="flex size-[calc(var(--mic)*0.75)] items-center justify-center rounded-full bg-destructive/10 text-destructive ring-1 ring-destructive/30">
				<SquareIcon class="size-9 fill-current" />
			</span>
		{:else}
			<span
				aria-hidden="true"
				class={cn(
					'text-(length:--mic) leading-none drop-shadow-lg transition-transform group-hover/button:scale-105 group-active/button:scale-95 motion-reduce:transition-none',
					pending && 'opacity-40',
				)}
			>
				🎙️
			</span>
			{#if pending}<Spinner class="absolute size-8" />{/if}
		{/if}
	</Button>

	<p class="flex h-8 items-center gap-2 text-sm text-muted-foreground @md/recorder:col-span-full @md/recorder:row-start-2">
		{#if library.recorder.phase === 'recording'}
			<span class="size-2 rounded-full bg-destructive" aria-hidden="true"></span>
			<span class="text-2xl font-semibold text-foreground"><RecorderClock startedAt={library.recorder.startedAt} /></span>
		{:else if library.recorder.phase === 'starting'}
			Starting…
		{:else if library.recorder.phase === 'stopping'}
			Saving the audio…
		{:else}
			Click to record. Click again to save.
		{/if}
	</p>

	<!--
		Below the hint on narrow windows. With enough room, at the microphone's lower right, tucked into the corner its round button leaves empty.
		Each names itself and its current value in its label and tooltip, and opens its own popover, one at a time.
	-->
	<div
		class="relative flex items-center gap-0.5 @md/recorder:col-start-3 @md/recorder:row-start-1 @md/recorder:mb-[calc(var(--mic)/8)] @md/recorder:-ml-[calc(var(--mic)/8)] @md/recorder:self-end @md/recorder:justify-self-start"
		role="group"
		aria-label="Recording options"
	>
		<MicrophoneControl bind:open={() => openOption === 'microphone', (open) => setOpen('microphone', open)} />
		<TranscriptionControl bind:open={() => openOption === 'transcription', (open) => setOpen('transcription', open)} />
		<PostProcessingControl bind:open={() => openOption === 'post-processing', (open) => setOpen('post-processing', open)} />
	</div>
</div>

<!-- Always mounted so the start of a recording is announced. The clock stays outside it: it changes every second. -->
<span class="sr-only" role="status">{active ? 'Recording' : ''}</span>

{#if library.services.capture.source === 'fixture'}
	<p class="text-center text-xs text-balance text-warning" data-testid="fixture-notice">
		Fixture mode: recordings use {library.services.capture.label}. The microphone is not used.
	</p>
{/if}

{#if library.captureNotice}
	<p class="text-center text-sm text-warning" role="status" data-testid="capture-notice">{library.captureNotice}</p>
{/if}
{#if library.recorderError}
	<p class="text-center text-sm text-destructive" role="alert" data-testid="recorder-error">{library.recorderError}</p>
{/if}
