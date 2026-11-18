<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { createMutation } from '@tanstack/svelte-query';
	import { toast } from 'svelte-sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { goto } from '$app/navigation';
	import { pathOf } from './nav-items.js';
	import { getLibrary } from '$lib/library.svelte.js';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import AudioMissing from './AudioMissing.svelte';
	import AudioPlayer from './AudioPlayer.svelte';
	import { copyText, formatTime, titleOf } from './file-actions.js';
	import RecorderCard from './RecorderCard.svelte';
	import RunFailure from './RunFailure.svelte';

	const whispering = getWhispering();
	const library = getLibrary();
	const { ui } = library;

	/** The newest kept recording. */
	const latest = $derived(library.entries[0]);
	/** Where its audio is. */
	const audio = $derived(latest ? library.audioOf(latest.id) : undefined);
	const transcript = $derived(latest ? library.resultsFor(latest.id)[0] : undefined);
	/** A transcription started here; its error shows while it is of the latest recording. */
	const transcription = createMutation(() => ({
		...library.transcription,
		onError: (error) => toast.error('The recording was not transcribed', { description: error.message }),
	}));
	const failed = $derived(
		latest !== undefined && transcription.error !== null && transcription.variables?.recordingId === latest.id,
	);
	const transcribing = $derived(latest !== undefined && library.transcribing(latest.id));
	const model = $derived(whispering.choice('transcription')?.model);

	/** Show the recording on the Recordings page. */
	async function openRecording(id: string) {
		if (!library.openRecording(id)) return;
		ui.showingDetail = true;
		await goto(pathOf('recordings'));
	}
</script>

<svelte:head><title>Whispering</title></svelte:head>

<!-- The spacers hold the recorder just above the middle while there is room. A long latest recording takes that room, then the page scrolls. -->
<div class="@container/recorder mx-auto flex w-full max-w-xl flex-1 flex-col items-center px-4 py-8">
	<div class="flex-2"></div>
	<div class="flex w-full flex-col items-center gap-4">
		<SectionHeader.Root class="space-y-3 text-center">
			<SectionHeader.Title level={1} class="text-3xl font-bold tracking-tight sm:text-4xl">Whispering</SectionHeader.Title>
			<SectionHeader.Description class="text-base">Record audio. Transcribe it when you’re ready.</SectionHeader.Description>
		</SectionHeader.Root>

		<RecorderCard />
	</div>

	<div class="w-full flex-3">
		{#if latest}
			<section class="mt-8 flex flex-col gap-2 border-t pt-5" aria-label="Latest recording" data-testid="latest-recording">
				<div class="flex items-center gap-2 text-sm">
					<h2 class="min-w-0 flex-1 truncate font-medium">{titleOf(latest)}</h2>
					<span class="shrink-0 text-xs text-muted-foreground max-sm:hidden">{formatTime(latest.recordedAt, 'short')}</span>
				</div>

				{#if failed && transcription.error && transcription.variables}
					{@const variables = transcription.variables}
					<RunFailure
						message={transcription.error.message}
						onRetry={() => transcription.mutate(variables)}
						onDismiss={() => transcription.reset()}
					/>
				{/if}
				{#if transcript}
					<div class="flex items-start gap-2 rounded-md border p-3 text-sm">
						<p class="max-h-40 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap" data-testid="latest-transcript">
							{transcript.body.trim() || '(empty transcript)'}
						</p>
						<Button size="xs" variant="outline" onclick={() => void copyText(transcript.body, 'the transcript')} data-testid="copy-latest">
							Copy
						</Button>
					</div>
				{:else if audio?.kind === 'here' && !failed}
					<p class="text-sm text-muted-foreground">
						{#if transcribing}
							Transcribing…
						{:else if model}
							Not transcribed yet. Nothing is sent until you press Transcribe.
						{:else}
							No transcription model is chosen. Choose one in Settings; nothing is sent until you do.
						{/if}
					</p>
				{/if}

				<!-- On a narrow window the player takes its own line, so its scrubber and duration stay visible. -->
				<div class="flex flex-wrap items-center gap-2">
					{#if audio?.kind === 'here'}
						<div class="min-w-0 flex-1 basis-full sm:basis-0">
							{#key latest.id}
								<AudioPlayer id={latest.id} file={audio.file} label="Audio of {titleOf(latest)}" />
							{/key}
						</div>
					{:else if audio}
						<div class="flex-1 basis-full sm:basis-0"><AudioMissing {audio} /></div>
					{/if}
					{#if !transcript}
						<Button
							size="sm"
							disabled={audio?.kind !== 'here' || transcribing}
							onclick={() => transcription.mutate({ recordingId: latest.id })}
							data-testid="transcribe-latest"
						>
							{#if transcribing}<Spinner class="size-3.5" />{/if}
							Transcribe
						</Button>
					{/if}
					<Button size="sm" variant="outline" onclick={() => void openRecording(latest.id)} data-testid="open-latest">Open</Button>
				</div>
			</section>
		{/if}
	</div>
</div>
