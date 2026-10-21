<script lang="ts">
	import { audioRead } from '$lib/file-reads.js';
	import { getFolder } from '$lib/folder.js';

	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { transformationName } from '$lib/post-processing.js';
	import { getWhispering } from '$lib/whispering.svelte.js';
	import AudioAbsent from './components/AudioAbsent.svelte';
	import AudioPlayer from './components/AudioPlayer.svelte';
	import { confirmDelete, copyText, formatTime, openItem, recordingTitle } from './components/file-actions.js';
	import RecorderCard from './components/RecorderCard.svelte';
	import ResultStatus from './components/ResultStatus.svelte';
	import TransformationOutput from './components/TransformationOutput.svelte';

	const whispering = getWhispering();
	const context = getFolder();
	const { library, view } = whispering;

	/** The newest saved recording. A capture still being saved is in the notice under the header. */
	const latest = $derived(library.entries[0]);
	/** Playback and transcription use the same sibling resolution as recording details. */
	const audio = $derived(latest ? library.audioOf(latest) : undefined);
	const audioPath = $derived(audio?.kind === 'here' ? audio.path : undefined);
	/** Whether the audio the newest recording names is missing from this device's folder. */
	const absent = $derived(audio?.kind === 'absent');
	const transcript = $derived(latest ? library.resultsFor(latest.stem)[0] : undefined);
	const run = $derived(latest ? library.transcriptionRun(latest.stem) : undefined);
	/** Whether the newest transcript has its answer, or what is happening to it. */
	const progress = $derived(transcript && library.resultState(transcript.path, transcript.row.body));
	const model = $derived(library.connections?.transcription?.model);

	/** The transformation chosen beside the recorder, as the folder and the text connection have it now. */
	const postProcessing = $derived(whispering.postProcessing);
	/** Whether a transformation of the newest transcript is under way. Its result shows below once its file is written. */
	const postRunning = $derived(
		transcript !== undefined && library.recipeRuns.some((item) => item.transcriptionId === transcript.stem),
	);
	const outputs = $derived(transcript ? library.outputsFor(transcript.stem) : []);

	/** Run the chosen transformation on the latest transcript. This press is the only thing that sends it. */
	async function runPostProcessing() {
		if (transcript === undefined || postProcessing.kind !== 'ready') return;
		const problem = await library.transform(transcript.path, postProcessing.entry.path);
		if (problem) toast.error('Post-processing did not run', { description: problem });
	}

	/** Show the recording, or one of its results, on the Recordings page. */
	async function openFile(path: string) {
		if (!(await openItem(library, path))) return;
		view.showingDetail = true;
		await goto(resolve('/recordings'));
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

		<RecorderCard {library} />
	</div>

	<div class="w-full flex-3">
		{#if latest}
			<section class="mt-8 flex flex-col gap-2 border-t pt-5" aria-label="Latest recording" data-testid="latest-recording">
				<div class="flex items-center gap-2 text-sm">
					<h2 class="min-w-0 flex-1 truncate font-medium">{recordingTitle(latest)}</h2>
					{#if latest.row.fields.capture === 'fixture'}<Badge variant="outline">Fixture</Badge>{/if}
					<span class="shrink-0 text-xs text-muted-foreground max-sm:hidden">{formatTime(latest.row.fields.recordedAt, 'short')}</span>
				</div>

				{#if transcript && progress && progress.kind !== 'answered'}
					<ResultStatus
						{library}
						path={transcript.path}
						result={progress}
						audioAbsent={absent}
						onDelete={() => void confirmDelete(library, transcript.path)}
					/>
				{:else if transcript}
					<div class="flex items-start gap-2 rounded-md border p-3 text-sm">
						<p class="max-h-40 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap" data-testid="latest-transcript">
							{transcript.row.body.trim() || '(empty transcript)'}
						</p>
						<Button size="xs" variant="outline" onclick={() => void copyText(transcript.row.body, 'the transcript')} data-testid="copy-latest">
							Copy
						</Button>
					</div>

					<!-- Post-processing never starts by itself. The transcript above is not changed by it: a result is its own file. -->
					{#if postProcessing.kind === 'ready'}
						{@const chosen = library.resolve(postProcessing.entry.row)}
						{@const name = transformationName(postProcessing.entry)}
						<div class="flex flex-wrap items-center gap-2 text-sm">
							<!-- The visible label stays short: a title can be longer than a narrow window. The name is in the accessible label and the tooltip. -->
							<Button
								size="sm"
								variant="outline"
								disabled={!transcript.row.body.trim() || postRunning}
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
								? 'The transformation chosen for post-processing is no longer in the folder. Choose another beside the recorder.'
								: `“${transformationName(postProcessing.entry)}” cannot run: ${postProcessing.reason}`}
						</p>
					{/if}
					{#if outputs[0]}
						<TransformationOutput
							{library}
							output={{ source: 'transcript', entry: outputs[0] }}
							naming="transformation"
							onOpenFile={(path) => void openFile(path)}
						/>
						{#if outputs.length > 1}
							<p class="text-xs text-muted-foreground">
								{outputs.length - 1 === 1 ? '1 earlier result is' : `${outputs.length - 1} earlier results are`} on the recording’s page.
							</p>
						{/if}
					{/if}
				{:else if run?.kind === 'failed'}
					<p class="text-sm text-destructive" role="alert" data-testid="transcription-error">{run.message}</p>
				{:else if audioPath && !absent}
					<p class="text-sm text-muted-foreground">
						{#if run?.kind === 'running'}
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
					{#if absent}
						<div class="flex-1 basis-full sm:basis-0"><AudioAbsent /></div>
					{:else if audio?.kind === 'ambiguous'}
						<p class="flex-1 text-sm text-destructive" role="alert">More than one audio file matches this recording. Open it to keep one matching file.</p>
					{:else if audioPath}
						<div class="min-w-0 flex-1 basis-full sm:basis-0">
							<AudioPlayer
								source={{ kind: 'file', query: context.queries.file(audioPath, audioRead) }}
								label="Audio of {recordingTitle(latest)}"
							/>
						</div>
					{:else}
						<p class="flex-1 basis-full text-sm text-muted-foreground sm:basis-0">Checking this recording’s audio beside its Markdown file.</p>
					{/if}
					{#if !transcript}
						<Button
							size="sm"
							tooltip={model ? `Transcribes with ${model}` : undefined}
							disabled={audioPath === undefined || absent || run?.kind === 'running'}
							onclick={() => void library.transcribe(latest)}
							data-testid="transcribe-latest"
						>
							{#if run?.kind === 'running'}<Spinner class="size-3.5" />{/if}
							{run?.kind === 'failed' ? 'Try again' : 'Transcribe'}
						</Button>
					{/if}
					<Button size="sm" variant="outline" onclick={() => void openFile(latest.path)} data-testid="open-latest">Open</Button>
				</div>
			</section>
		{/if}
	</div>
</div>
