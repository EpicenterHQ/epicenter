<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { cn } from '@epicenter/ui/utils';
	import { commandRunners } from '$lib/commands';
	import ImportFileButton from '$lib/components/ImportFileButton.svelte';
	import {
		CaptureSurfaceSelector,
		TranscriptionSelector,
	} from '$lib/components/settings';
	import ManualDeviceSelector from '$lib/components/settings/selectors/ManualDeviceSelector.svelte';
	import VadDeviceSelector from '$lib/components/settings/selectors/VadDeviceSelector.svelte';
	import {
		MANUAL_RECORDING_BUTTON,
		VAD_RECORDING_BUTTON,
	} from '$lib/constants/audio';
	import { resolve } from '$app/paths';
	import { captureSurface } from '$lib/state/capture-surface.svelte';
		import { vadRecorder } from '$lib/state/vad-recorder.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();

	let { children } = $props();

	const ManualButtonIcon = $derived(
		MANUAL_RECORDING_BUTTON[app.recording.state].Icon,
	);
	const VadButtonIcon = $derived(VAD_RECORDING_BUTTON[vadRecorder.state].Icon);
</script>

<header
	class={cn(
		'border-border/40 bg-background/95 supports-backdrop-filter:bg-background/60 z-10 border-b shadow-xs backdrop-blur-sm',
		'flex h-14 w-full items-center justify-between px-4 sm:px-8',
	)}
>
	<Button tooltip="Go home" href={resolve('/')} variant="ghost" class="-ml-4">
		<span class="text-lg font-bold">whispering</span>
	</Button>

	<!-- The row hides while a capture is live: the pill owns stop and cancel on
	every route, and the state-derived toggle here would just duplicate them. -->
	<div class="flex items-center gap-1.5">
		{#if captureSurface.current(app) === 'manual' && app.recording.state !== 'RECORDING'}
			<ManualDeviceSelector
				iconViewTransitionName={viewTransition.pipeline.device}
			/>
			<TranscriptionSelector
				variant="standalone"
				iconViewTransitionName={viewTransition.pipeline.transcription}
			/>
			<div class="flex">
				<Button
					tooltip="Start recording"
					onclick={() => commandRunners.toggleManualRecording(app)}
					variant="ghost"
					size="icon"
					class="rounded-r-none border-r-0"
				>
					<span
						class="inline-flex shrink-0"
						style:view-transition-name={viewTransition.recordingMode('manual')}
					>
						<ManualButtonIcon class="size-4" />
					</span>
				</Button>
				<CaptureSurfaceSelector class="rounded-l-none" />
			</div>
		{:else if captureSurface.current(app) === 'vad' && vadRecorder.state === 'IDLE'}
			<VadDeviceSelector
				iconViewTransitionName={viewTransition.pipeline.device}
			/>
			<TranscriptionSelector
				variant="standalone"
				iconViewTransitionName={viewTransition.pipeline.transcription}
			/>
			<div class="flex">
				<Button
					tooltip="Start voice activated recording"
					onclick={() => commandRunners.toggleVadRecording(app)}
					variant="ghost"
					size="icon"
					class="rounded-r-none border-r-0"
				>
					<span
						class="inline-flex shrink-0"
						style:view-transition-name={viewTransition.recordingMode('vad')}
					>
						<VadButtonIcon class="size-4" />
					</span>
				</Button>
				<CaptureSurfaceSelector class="rounded-l-none" />
			</div>
		{:else if captureSurface.current(app) === 'import'}
			<TranscriptionSelector
				variant="standalone"
				iconViewTransitionName={viewTransition.pipeline.transcription}
			/>
			<div class="flex">
				<ImportFileButton class="rounded-r-none border-r-0" />
				<CaptureSurfaceSelector class="rounded-l-none" />
			</div>
		{/if}
	</div>
</header>

<div class="flex-1 overflow-x-auto">{@render children()}</div>
