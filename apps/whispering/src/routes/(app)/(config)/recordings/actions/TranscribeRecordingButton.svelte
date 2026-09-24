<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import PlayIcon from '@lucide/svelte/icons/play';
	import RepeatIcon from '@lucide/svelte/icons/repeat';
	import { createMutation } from '@tanstack/svelte-query';
	import type { ComponentProps } from 'svelte';
	import { creditAction } from '$lib/operations/credit-action';
	import { report } from '$lib/report';
	import { playSoundIfEnabled } from '$lib/operations/sound';
	import { local } from '$lib/whispering/local';
	import { latestTranscription } from '$lib/whispering/transcriptions';
	import type { Recording } from '../../../../../lib/data.js';
	import {
		getWhisperingApp,
		getWhisperingQueries,
	} from '$lib/whispering/context';

	const app = getWhisperingApp();
	const queries = getWhisperingQueries();

	/**
	 * The transcribe / retry button for a single recording.
	 *
	 * Liveness is the in-flight mutation, not a stored field: while this
	 * recording's transcription is pending it reads as transcribing, otherwise
	 * the stored outcome (completed/failed) or its absence (unprocessed) decides
	 * the state. Shared by the compact row action (icon-only) and the detail
	 * modal toolbar (labelled), so the state machine lives in exactly one place.
	 */
	let {
		recording,
		variant = 'ghost',
		size = 'icon',
		showLabel = false,
	}: {
		recording: Recording;
		variant?: ComponentProps<typeof Button>['variant'];
		size?: ComponentProps<typeof Button>['size'];
		/** Render the action's text beside the icon (detail modal toolbar). */
		showLabel?: boolean;
	} = $props();

	const transcribeRecording = createMutation(
		() => queries.transcription.transcribeRecording.options,
	);

	// `pending` is the recording domain's initialization value for a recording nobody has
	// transcribed yet, which is this button's "unprocessed".
	const transcriptionState = $derived.by(() => {
		if (transcribeRecording.isPending)
			return { status: 'transcribing' } as const;
		return { status: latestTranscription(local, recording.id) ? 'completed' : 'unprocessed' } as const;
	});

	const tooltip = $derived.by(() => {
		switch (transcriptionState.status) {
			case 'unprocessed':
				return 'Start transcribing this recording';
			case 'transcribing':
				return 'Currently transcribing...';
			case 'completed':
				return 'Retry transcription';
		}
	});

	const label = $derived.by(() => {
		switch (transcriptionState.status) {
			case 'unprocessed':
				return 'Transcribe';
			case 'transcribing':
				return 'Transcribing...';
			case 'completed':
				return 'Retry';
		}
	});

	function transcribe() {
		const loading = report.loading({
			title: 'Transcribing...',
			description: 'Your recording is being transcribed...',
		});
		transcribeRecording.mutate(recording, {
			onError: (error) => {
				// `error` is the mutation's `TError` (the operation's
				// TranscriptionError, which is AnyTaggedError), so it flows
				// straight into `cause` with no assertion. Omit `description`
				// so the toast falls back to the provider's own message (e.g.
				// "OpenAI API key is required") instead of a generic line.
				loading.reject({
					cause: error,
					title: 'Failed to transcribe recording',
					action: creditAction(error, app.authAccount),
				});
			},
			onSuccess: ({ history }) => {
				void playSoundIfEnabled('transcriptionComplete');
				loading.resolve({
					title: history.error
						? 'Transcription finished; save needs attention'
						: 'Transcription saved to recording history',
				});
				if (history.error !== null) {
					report.info({
						title: 'Transcription history may be incomplete',
						description: history.error.message,
					});
				}
			},
		});
	}
</script>

<Button {tooltip} aria-label={tooltip} onclick={transcribe} {variant} {size}>
	{#if transcriptionState.status === 'unprocessed'}
		<PlayIcon class="size-4" />
	{:else if transcriptionState.status === 'transcribing'}
		<EllipsisIcon class="size-4" />
	{:else if transcriptionState.status === 'completed'}
		<RepeatIcon class="size-4 text-green-500" />
	{/if}
	{#if showLabel}{label}{/if}
</Button>
