<script lang="ts">
	import { fromSubscription } from '@epicenter/svelte';
	import { FileDropZone } from '@epicenter/ui/file-drop-zone';
	import { Link } from '@epicenter/ui/link';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import type { UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
	import { tryAsync } from 'wellcrafted/result';
	import DictationCapabilityNotice from '$lib/components/DictationCapabilityNotice.svelte';
	import { TranscriptionSelector } from '$lib/components/settings';
	import ManualDeviceSelector from '$lib/components/settings/selectors/ManualDeviceSelector.svelte';
	import VadDeviceSelector from '$lib/components/settings/selectors/VadDeviceSelector.svelte';
	import {
		CAPTURE_SURFACE_META,
		CAPTURE_SURFACE_OPTIONS,
		type CaptureSurface,
	} from '$lib/constants/audio';
	import {
		IMPORT_ACCEPT,
		IMPORTABLE_AUDIO_EXTENSIONS,
		IMPORTABLE_VIDEO_EXTENSIONS,
		MAX_IMPORT_FILES,
		MAX_IMPORT_FILE_SIZE,
	} from '$lib/constants/import-formats';
	import { resolve } from '$app/paths';
	import { importFiles } from '$lib/operations/import';
	import { selectCaptureSurface } from '$lib/operations/recording.svelte.js';
	import { deleteRecordingsWithConfirmation } from '$lib/operations/delete-recordings';
	import { report } from '$lib/report';
	import {
		getTranscriptionReadiness,
	} from '$lib/settings/transcription-validation';
	import { captureSurface } from '$lib/state/capture-surface.svelte';
	import { getRecordingShortcutLabel } from '$lib/utils/recording-shortcut';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import { getWhisperingApp } from '$lib/whispering/context';
	import studioMicrophone from '$lib/assets/studio-microphone.png';
	import { tauri } from '#platform/tauri';
	import CaptureBehaviorPopover from './_components/CaptureBehaviorPopover.svelte';
	import CapturePipeline from './_components/CapturePipeline.svelte';
	import ManualRecordingAction from './_components/ManualRecordingAction.svelte';
	import PolishStatusLink from './_components/PolishStatusLink.svelte';
	import RecordingResult from './_components/RecordingResult.svelte';
	import VadRecordingAction from './_components/VadRecordingAction.svelte';

	const app = getWhisperingApp();

	const latestRecording = $derived(app.recordings.sorted[0]);
	const transcriptionSelection = fromSubscription(
		app.inferenceConnections.selections.onChange,
		() => app.inferenceConnections.selections.get('transcription'),
	);
	const audioOnly = $derived(app.settings.get('transcriptionService') === 'connection' && transcriptionSelection.current === null);
	const transcriptionReadiness = $derived(getTranscriptionReadiness(app));
	const hasActiveShortcut = $derived.by(() => {
		const surface = captureSurface.current(app);
		if (surface === 'import') return false;
		return !!getRecordingShortcutLabel(app, surface);
	});
	const PageError = defineErrors({
		DragDropListenerFailed: ({ cause }: { cause: unknown }) => ({
			message: `Failed to set up drag drop listener: ${extractErrorMessage(cause)}`,
			cause,
		}),
		FileRejected: ({
			fileName,
			reason,
		}: {
			fileName: string;
			reason: string;
		}) => ({
			message: `${fileName}: ${reason}`,
			fileName,
			reason,
		}),
	});

	let unlistenDragDrop: UnlistenFn | undefined;

	onMount(async () => {
		const desktop = tauri;
		if (!desktop) return;
		const { error } = await tryAsync({
			try: async () => {
				const isAudio = async (path: string) =>
					IMPORTABLE_AUDIO_EXTENSIONS.includes(
						(await desktop.fs.extension(
							path,
						)) as (typeof IMPORTABLE_AUDIO_EXTENSIONS)[number],
					);
				const isVideo = async (path: string) =>
					IMPORTABLE_VIDEO_EXTENSIONS.includes(
						(await desktop.fs.extension(
							path,
						)) as (typeof IMPORTABLE_VIDEO_EXTENSIONS)[number],
					);

				unlistenDragDrop = await desktop.fs.onDragDrop(
					async (paths) => {
						const pathResults = await Promise.all(
							paths.map(async (path) => ({
								path,
								isValid: (await isAudio(path)) || (await isVideo(path)),
							})),
						);
						const validPaths = pathResults
							.filter(({ isValid }) => isValid)
							.map(({ path }) => path);

						if (validPaths.length === 0) {
							report.info({
								title: 'No valid files',
								description: 'Please drop audio or video files',
							});
							return;
						}

						const { data: files, error } =
							await desktop.fs.pathsToFiles(validPaths);

						if (error) {
							report.error({ cause: error, title: 'Failed to read files' });
							return;
						}

						if (files.length > 0) {
							await importFiles(app, { files });
						}
					},
				);
			},
			catch: (error) =>
				PageError.DragDropListenerFailed({
					cause: error,
				}),
		});
		if (error) report.error({ cause: error });
	});

	onDestroy(() => {
		unlistenDragDrop?.();
	});
</script>

<svelte:head> <title>Whispering</title> </svelte:head>

<div
	class="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-start gap-5 px-4 pt-8 pb-24 sm:justify-center sm:py-12"
>
	<SectionHeader.Root class="flex flex-col items-center gap-2 text-center">
		<div class="flex items-center gap-2.5">
			<img src={studioMicrophone} alt="" class="size-8" />
			<SectionHeader.Title level={1} class="text-3xl">Whispering</SectionHeader.Title>
		</div>
		<SectionHeader.Description class="text-base">
			Record now. Turn it into text when you’re ready.
		</SectionHeader.Description>
	</SectionHeader.Root>

	<DictationCapabilityNotice />

	<ToggleGroup.Root
		type="single"
		bind:value={() => captureSurface.current(app),
			(surface) => {
				if (!surface) return;
				void selectCaptureSurface(app, surface as CaptureSurface);
			}}
		class="w-full"
	>
		{#each CAPTURE_SURFACE_OPTIONS as option}
			{@const SurfaceIcon = CAPTURE_SURFACE_META[option.value].Icon}
			<ToggleGroup.Item
				value={option.value}
				aria-label="Switch to {option.label.toLowerCase()}"
			>
				<SurfaceIcon class="size-4" />
				<span class="hidden truncate sm:inline">{option.label}</span>
			</ToggleGroup.Item>
		{/each}
	</ToggleGroup.Root>

	{#if captureSurface.current(app) === 'manual'}
		<div class="flex w-full flex-col items-center gap-3">
			<ManualRecordingAction>
				{#snippet footer()}
					<CapturePipeline>
						<ManualDeviceSelector
							iconViewTransitionName={viewTransition.pipeline.device}
						/>
						<TranscriptionSelector
							variant="pipeline"
							iconViewTransitionName={viewTransition.pipeline.transcription}
						/>
						{#if transcriptionReadiness.isReady}<PolishStatusLink />{/if}
						<CaptureBehaviorPopover />
					</CapturePipeline>
				{/snippet}
			</ManualRecordingAction>
		</div>
	{:else if captureSurface.current(app) === 'vad'}
		<div class="flex w-full flex-col items-center gap-3">
			<VadRecordingAction>
				{#snippet footer()}
					<CapturePipeline>
						<VadDeviceSelector
							iconViewTransitionName={viewTransition.pipeline.device}
						/>
						<TranscriptionSelector
							variant="pipeline"
							iconViewTransitionName={viewTransition.pipeline.transcription}
						/>
						{#if transcriptionReadiness.isReady}<PolishStatusLink />{/if}
						<CaptureBehaviorPopover />
					</CapturePipeline>
				{/snippet}
			</VadRecordingAction>
		</div>
	{:else if captureSurface.current(app) === 'import'}
		<div class="flex w-full flex-col items-center gap-4">
			<FileDropZone
				accept={IMPORT_ACCEPT}
				maxFiles={MAX_IMPORT_FILES}
				maxFileSize={MAX_IMPORT_FILE_SIZE}
				onUpload={async (files) => {
					if (files.length > 0) {
						await importFiles(app, { files });
					}
				}}
				onFileRejected={({ file, reason }) => {
					report.error({
						cause: PageError.FileRejected({
							fileName: file.name,
							reason,
						}).error,
						title: 'File rejected',
					});
				}}
				class="h-32 sm:h-36 w-full"
			/>
			<CapturePipeline class="rounded-xl bg-card px-3 py-2 shadow-sm">
				<TranscriptionSelector
					variant="pipeline"
					iconViewTransitionName={viewTransition.pipeline.transcription}
				/>
				{#if transcriptionReadiness.isReady}<PolishStatusLink />{/if}
			</CapturePipeline>
		</div>
	{/if}

	{#if !transcriptionReadiness.isReady}
		<p class="text-center text-sm text-muted-foreground">
			{audioOnly ? 'Audio will be saved without transcription.' : transcriptionReadiness.primaryIssue}
			<Link href={resolve('/settings/processing')}>Set up transcription</Link>
		</p>
	{/if}

	{#if latestRecording}
		<RecordingResult
			recordingId={latestRecording.id}
			audio={latestRecording.audioBlobId}
			transcript={latestRecording.polishedTranscript ?? latestRecording.transcript}
			rows={1}
			onDelete={() => {
				deleteRecordingsWithConfirmation(app, latestRecording);
			}}
		/>
	{/if}

	{#if captureSurface.current(app) !== 'import'}
		<p class="text-muted-foreground text-center text-sm">
			{#if hasActiveShortcut}
				Your shortcut works
				{tauri ? 'from any app.' : 'while this window is focused.'}
				<Link href={resolve('/settings/shortcuts')}>Configure shortcuts</Link>
			{:else}
				<Link href={resolve('/settings/shortcuts')}>Set a shortcut</Link>
				{tauri ? 'to dictate from any app.' : 'to start recording.'}
			{/if}
		</p>
	{/if}

	{#if !tauri}
		<p class="text-muted-foreground text-center text-sm font-light">
			Tired of switching tabs?
			<Link
				tooltip="Get Whispering for desktop"
				href="https://epicenter.so/whispering"
				target="_blank"
				rel="noopener noreferrer"
			>
				Get the native desktop app
			</Link>
		</p>
	{/if}
</div>
