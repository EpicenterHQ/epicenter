<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { goto } from '$app/navigation';
	import { pathOf } from './nav-items.js';
	import { transformationName } from '$lib/post-processing.js';
	import { getLibrary } from '$lib/library.svelte.js';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import AudioMissing from './AudioMissing.svelte';
	import AudioPlayer from './AudioPlayer.svelte';
	import { copyText, formatTime, titleOf } from './file-actions.js';
	import RecorderCard from './RecorderCard.svelte';
	import RunStatus from './RunStatus.svelte';
	import TransformationOutput from './TransformationOutput.svelte';
	import UnsavedRecordings from './UnsavedRecordings.svelte';

	const whispering = getWhispering();
	const library = getLibrary();
	const { ui } = library;

	/** The newest kept recording. */
	const latest = $derived(library.entries[0]);
	/** Where its audio is. */
	const audio = $derived(latest ? library.audioOf(latest.id) : undefined);
	const transcript = $derived(latest ? library.resultsFor(latest.id)[0] : undefined);
	/** A transcription of it in this window, and what became of it. */
	const run = $derived(latest ? library.transcriptionRun(latest.id) : undefined);
	const transcribing = $derived(run?.state.kind === 'running' || (run?.state.kind === 'unsaved' && run.state.message === undefined));
	const model = $derived(whispering.connections?.transcription?.model);

	/** The transformation chosen beside the recorder, as the lists and the text connection have it now. */
	const postProcessing = $derived(library.postProcessing);
	/** Whether a transformation of the newest transcript is under way. Its result shows below once kept. */
	const postRunning = $derived(
		transcript !== undefined && library.runsOn(transcript.id).some((item) => item.state.kind === 'running'),
	);
	const postRuns = $derived(transcript ? library.runsOn(transcript.id).filter((item) => item.state.kind !== 'running') : []);
	const outputs = $derived(transcript ? library.outputsFor(transcript.id) : []);

	/** Run the chosen transformation on the latest transcript. This press is the only thing that sends it. */
	async function runPostProcessing() {
		if (transcript === undefined || postProcessing.kind !== 'ready') return;
		const problem = await library.transform(transcript.id, postProcessing.entry.id);
		if (problem) toast.error('Post-processing did not run', { description: problem });
	}

	async function transcribe(id: string) {
		const problem = await library.transcribe(id);
		if (problem && library.transcriptionRun(id) === undefined) toast.error('Nothing was sent', { description: problem });
	}

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
		<UnsavedRecordings />
	</div>

	<div class="w-full flex-3">
		{#if latest}
			<section class="mt-8 flex flex-col gap-2 border-t pt-5" aria-label="Latest recording" data-testid="latest-recording">
				<div class="flex items-center gap-2 text-sm">
					<h2 class="min-w-0 flex-1 truncate font-medium">{titleOf(latest)}</h2>
					{#if latest.capture === 'fixture'}<Badge variant="outline">Fixture</Badge>{/if}
					<span class="shrink-0 text-xs text-muted-foreground max-sm:hidden">{formatTime(latest.recordedAt, 'short')}</span>
				</div>

				{#if run && run.state.kind !== 'running'}
					<RunStatus {run} />
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

					<!-- Post-processing never starts by itself. The transcript above is not changed by it: a result is its own file. -->
					{#if postProcessing.kind === 'ready'}
						{@const chosen = whispering.resolve(postProcessing.entry)}
						{@const name = transformationName(postProcessing.entry)}
						<div class="flex flex-wrap items-center gap-2 text-sm">
							<!-- The visible label stays short: a title can be longer than a narrow window. The name is in the accessible label and the tooltip. -->
							<Button
								size="sm"
								variant="outline"
								disabled={!transcript.body.trim() || postRunning}
								aria-label="Run post-processing: {name}"
								tooltip={chosen.kind === 'ready' ? `Runs “${name}”: sends this transcript to ${chosen.model} at ${chosen.endpoint}` : undefined}
								onclick={() => void runPostProcessing()}
								data-testid="run-post-processing"
							>
								{#if postRunning}<Spinner class="size-3.5" />{:else}<WandSparklesIcon />{/if}
								Run post-processing
							</Button>
							<span class="text-xs text-muted-foreground">Nothing is sent until you press it.</span>
						</div>
					{:else if postProcessing.kind !== 'none'}
						<p class="text-sm break-words text-warning" role="status" data-testid="post-processing-unavailable">
							{postProcessing.kind === 'missing'
								? 'The transformation chosen for post-processing is no longer listed. Choose another beside the recorder.'
								: `“${transformationName(postProcessing.entry)}” cannot run: ${postProcessing.reason}`}
						</p>
					{/if}
					{#each postRuns as postRun (postRun.key)}
						<RunStatus run={postRun} />
					{/each}
					{#if outputs[0]}
						<TransformationOutput output={{ source: 'transcript', note: outputs[0] }} naming="transformation" />
						{#if outputs.length > 1}
							<p class="text-xs text-muted-foreground">
								{outputs.length - 1 === 1 ? '1 earlier result is' : `${outputs.length - 1} earlier results are`} on the recording’s page.
							</p>
						{/if}
					{/if}
				{:else if audio?.kind === 'here' && !(run && run.state.kind !== 'running')}
					<p class="text-sm text-muted-foreground">
						{#if transcribing}
							Transcribing…
						{:else if model}
							Not transcribed yet. Nothing is sent until you press Transcribe.
						{:else}
							Transcription is not set up. Set up its connection in Settings; nothing is sent until you do.
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
							tooltip={model ? `Transcribes with ${model}` : undefined}
							disabled={audio?.kind !== 'here' || transcribing}
							onclick={() => void transcribe(latest.id)}
							data-testid="transcribe-latest"
						>
							{#if transcribing}<Spinner class="size-3.5" />{/if}
							{run?.state.kind === 'failed' ? 'Try again' : 'Transcribe'}
						</Button>
					{/if}
					<Button size="sm" variant="outline" onclick={() => void openRecording(latest.id)} data-testid="open-latest">Open</Button>
				</div>
			</section>
		{/if}
	</div>
</div>
