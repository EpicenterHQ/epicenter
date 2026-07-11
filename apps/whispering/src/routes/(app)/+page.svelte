<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { FileDropZone } from '@epicenter/ui/file-drop-zone';
	import * as Kbd from '@epicenter/ui/kbd';
	import { Link } from '@epicenter/ui/link';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import { defineErrors } from 'wellcrafted/error';
	import DesktopPromotion from '#desktop-promotion';
	import { environment } from '#runtime';
	import DictationCapabilityNotice from '$lib/components/DictationCapabilityNotice.svelte';
	import TranscriptionOnboarding from '$lib/components/TranscriptionOnboarding.svelte';
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
		MAX_IMPORT_FILES,
		MAX_IMPORT_FILE_SIZE,
	} from '$lib/constants/import-formats';
	import { whisperingPath } from '$lib/constants/urls';
	import { importFiles } from '$lib/operations/import';
	import { selectCaptureSurface } from '$lib/operations/recording';
	import { deleteRecordingsWithConfirmation } from '$lib/operations/recordings';
	import { report } from '$lib/report';
	import { getTranscriptionReadiness } from '$lib/settings/transcription-validation';
	import { captureSurface } from '$lib/state/capture-surface.svelte';
	import { recordings } from '$lib/state/recordings.svelte';
	import {
		getRecordingShortcutLabels,
		type RecordingShortcutMode,
	} from '$lib/utils/recording-shortcut';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import studioMicrophone from '$lib/assets/studio-microphone.png';
	import CaptureBehaviorPopover from './_components/CaptureBehaviorPopover.svelte';
	import CapturePipeline from './_components/CapturePipeline.svelte';
	import ManualRecordingAction from './_components/ManualRecordingAction.svelte';
	import PolishPipelineControl from './_components/PolishPipelineControl.svelte';
	import RecordingResult from './_components/RecordingResult.svelte';
	import VadRecordingAction from './_components/VadRecordingAction.svelte';

	const latestRecording = $derived(recordings.sorted[0]);
	const captureSurfaceOptions = CAPTURE_SURFACE_OPTIONS.filter((option) =>
		environment.captureSurfaces.includes(option.value),
	);
	const transcriptionReadiness = $derived(getTranscriptionReadiness());
	// First success belongs to the real recorder, not a parallel practice wizard.
	// Live readiness plus the real recordings table owns this prompt, so setup
	// reloads cannot lose it and the first saved result dismisses it automatically.
	const showFirstDictationPrompt = $derived(
		transcriptionReadiness.isReady && !latestRecording,
	);
	// The verb fragments the hint drops around each key, per mode. `here` and
	// `anywhere` annotate the in-app and global keys with their reach; `fresh` is the
	// bare prompt shown when nothing is bound at all.
	type RecordingHintWords = { here: string; anywhere: string; fresh: string };
	const MANUAL_HINT_WORDS: RecordingHintWords = {
		here: 'record here',
		anywhere: 'record from anywhere',
		fresh: 'start recording',
	};
	const VAD_HINT_WORDS: RecordingHintWords = {
		here: 'listen here',
		anywhere: 'listen from anywhere',
		fresh: 'start a voice-activated session',
	};
	// A shortcut option in the hint: a bound key (a `Kbd` chip) or a call to set one
	// up. Both link into /settings/shortcuts, so the hint doubles as the way to
	// configure each key.
	type HintLink =
		| { kind: 'key'; label: string; tooltip: string }
		| { kind: 'cta'; label: string; tooltip: string };
	// One way to start a recording, as a "{lead}{link}{tail}" run. Spaces live inside
	// `lead`/`tail` so the parts concatenate verbatim when the hint joins them; `link`
	// is null for the mic, which names the on-screen button rather than a setting.
	type RecordingWay = { lead: string; link: HintLink | null; tail: string };
	// The ordered ways to start `mode`. The mic always works and leads; the in-app key
	// reaches "here" and the global key "from anywhere" when bound. The mic states its
	// own verb only when it is the only way.
	function recordingWays(
		mode: RecordingShortcutMode,
		words: RecordingHintWords,
	): RecordingWay[] {
		const { focused, global } = getRecordingShortcutLabels(mode);
		const ways: RecordingWay[] = [];
		if (focused) {
			ways.push({
				lead: 'press ',
				link: {
					kind: 'key',
					label: focused,
					tooltip: 'Configure the in-app shortcut',
				},
				tail: ` to ${words.here}`,
			});
		}
		// The from-anywhere tier exists only where there is a system backend, which
		// `global` reports as non-null (`''` there means the slot is just unbound).
		if (global !== null) {
			ways.push(
				global
					? {
							lead: 'press ',
							link: {
								kind: 'key',
								label: global,
								tooltip: 'Configure the global shortcut',
							},
							tail: ` to ${words.anywhere}`,
						}
					: {
							lead: '',
							link: {
								kind: 'cta',
								label: 'set a global shortcut',
								tooltip: 'Set a global shortcut',
							},
							tail: ` to ${words.anywhere}`,
						},
			);
		}
		ways.unshift({
			lead: 'Click the microphone',
			link: null,
			tail: ways.length ? '' : ` to ${words.fresh}`,
		});
		return ways;
	}
	// Join the ways as an or-list: "a", "a, or b", "a, b, or c".
	const orPrefix = (index: number, count: number) =>
		index === 0 ? '' : index === count - 1 ? ', or ' : ', ';
	const manualWays = $derived(recordingWays('manual', MANUAL_HINT_WORDS));
	const vadWays = $derived(recordingWays('vad', VAD_HINT_WORDS));
	const PageError = defineErrors({
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

</script>

<svelte:head> <title>Whispering</title> </svelte:head>

<div
	class="flex flex-1 flex-col items-center justify-start gap-4 w-full max-w-lg mx-auto px-4 pt-6 pb-24 sm:justify-center sm:py-0"
>
	<SectionHeader.Root
		class="flex flex-col items-center {transcriptionReadiness.isReady
			? 'gap-3'
			: 'gap-2'}"
	>
		<div class="flex items-center gap-3">
			<img
				src={studioMicrophone}
				alt=""
				class={transcriptionReadiness.isReady ? 'size-12' : 'size-10'}
			/>
			<SectionHeader.Title
				level={1}
				class={transcriptionReadiness.isReady
					? 'scroll-m-20 text-4xl tracking-tight lg:text-5xl'
					: 'scroll-m-20 text-3xl tracking-tight'}
			>
				Whispering
			</SectionHeader.Title>
		</div>
		{#if transcriptionReadiness.isReady && !showFirstDictationPrompt}
			<SectionHeader.Description class="text-center">
				Press shortcut → speak → get text. Free and open source ❤️
			</SectionHeader.Description>
		{/if}
	</SectionHeader.Root>

	{#if !transcriptionReadiness.isReady}
		<TranscriptionOnboarding />
	{:else}
		{#if showFirstDictationPrompt}
			<h2 class="text-xl font-semibold tracking-tight">
				Try your first dictation
			</h2>
		{/if}

		<DictationCapabilityNotice />

		<ToggleGroup.Root
			type="single"
			bind:value={() => captureSurface.current,
				(surface) => {
					if (!surface) return;
					void selectCaptureSurface(surface as CaptureSurface);
				}}
			class="w-full"
		>
			{#each captureSurfaceOptions as option}
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

		<!--
			The capture pipeline is each recording action's idle footer (the action
			hides it while live), so it's defined inline per surface. Manual and VAD
			differ only by their device selector; each owns a distinct one backed by a
			different recorder config. The shared tail repeats, but that keeps each
			surface's footer co-located with the branch that already chose it, rather
			than re-deriving the surface inside a shared snippet.
		-->
		{#if captureSurface.current === 'manual'}
			<div class="flex w-full flex-col items-center gap-3">
				<ManualRecordingAction>
					{#snippet pipeline()}
						<CapturePipeline>
							<ManualDeviceSelector
								iconViewTransitionName={viewTransition.pipeline.device}
							/>
							<TranscriptionSelector
								variant="pipeline"
								iconViewTransitionName={viewTransition.pipeline.transcription}
							/>
							<PolishPipelineControl />
							<CaptureBehaviorPopover />
						</CapturePipeline>
					{/snippet}
				</ManualRecordingAction>
			</div>
		{:else if captureSurface.current === 'vad'}
			<div class="flex w-full flex-col items-center gap-3">
				<VadRecordingAction>
					{#snippet pipeline()}
						<CapturePipeline>
							<VadDeviceSelector
								iconViewTransitionName={viewTransition.pipeline.device}
							/>
							<TranscriptionSelector
								variant="pipeline"
								iconViewTransitionName={viewTransition.pipeline.transcription}
							/>
							<PolishPipelineControl />
							<CaptureBehaviorPopover />
						</CapturePipeline>
					{/snippet}
				</VadRecordingAction>
			</div>
		{:else if captureSurface.current === 'import'}
			<div class="flex w-full flex-col items-center gap-4">
				<FileDropZone
					accept={IMPORT_ACCEPT}
					maxFiles={MAX_IMPORT_FILES}
					maxFileSize={MAX_IMPORT_FILE_SIZE}
					onUpload={async (files) => {
						if (files.length > 0) {
							await importFiles({ files });
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
				<CapturePipeline>
					<TranscriptionSelector
						variant="pipeline"
						iconViewTransitionName={viewTransition.pipeline.transcription}
					/>
					<PolishPipelineControl />
				</CapturePipeline>
			</div>
		{/if}

		{#if latestRecording}
			<RecordingResult
				recordingId={latestRecording.id}
				transcript={latestRecording.polishedTranscript ?? latestRecording.transcript}
				rows={1}
				onDelete={() => {
					deleteRecordingsWithConfirmation(latestRecording);
				}}
			/>
		{/if}

		<div class="flex flex-col items-center gap-3">
			{#if captureSurface.current === 'manual'}
				<p class="text-foreground/75 text-center text-sm">
					{@render recordingHint(manualWays)}
				</p>
			{:else if captureSurface.current === 'vad'}
				<p class="text-foreground/75 text-center text-sm">
					{@render recordingHint(vadWays)}
				</p>
			{/if}
			<p class="text-muted-foreground text-center text-sm font-light">
				<DesktopPromotion />
			</p>
		</div>
	{/if}
</div>

<!-- A shortcut option as a link into settings: a key chip, or the "set one up" call
to action. -->
{#snippet shortcutLink(link: HintLink)}
	<Link tooltip={link.tooltip} href={whisperingPath('/settings/shortcuts')}>
		{#if link.kind === 'key'}
			<Kbd.Root>{link.label}</Kbd.Root>
		{:else}{link.label}{/if}
	</Link>
{/snippet}

<!-- One way rendered as its "{lead}{link}{tail}" run. Kept on one line so no template
whitespace creeps between the parts; every needed space lives in the strings. -->
{#snippet hintWay(way: RecordingWay)}{way.lead}{#if way.link}{@render shortcutLink(way.link)}{/if}{way.tail}{/snippet}

<!-- The home recording hint: every way to start a recording, joined as an or-list.
`recordingWays` decides which ways exist; this only joins and punctuates them. -->
{#snippet recordingHint(ways: RecordingWay[])}
	{#each ways as way, i}{orPrefix(i, ways.length)}{@render hintWay(way)}{/each}.
{/snippet}
