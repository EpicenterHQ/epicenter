import type { Recording, RecordingService } from '@epicenter/app/recorder';
import {
	RecorderError,
	type RecordingEndedReason,
} from '@epicenter/app/recorder';
import { InstantString } from '@epicenter/data/field';
import type { DeviceAcquisitionOutcome } from '@epicenter/recorder';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import { defineKeys, resultQueryOptions } from 'wellcrafted/query';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import { manualRecorderConfig } from '#platform/manual-recorder-config';
import { reportRecordingMicLevel } from '#platform/recording-mic-level';
import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import type {
	CaptureSurface,
	WhisperingRecordingState,
} from '$lib/constants/audio';
import { logAnalyticsEvent } from '$lib/operations/analytics';
import { recordingMedia } from '$lib/operations/media';
import { processRecordingPipeline } from '$lib/operations/pipeline';
import { playSoundIfEnabled } from '$lib/operations/sound';
import { captureTranscription } from '$lib/operations/transcribe';
import { report } from '$lib/report';
import { captureSurface } from '$lib/state/capture-surface.svelte';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import {
	drainRecordingWork,
	trackRecordingWork,
} from '$lib/state/recording-active.svelte';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

const log = createLogger('whispering/recording');

const RecordingDeviceError = defineErrors({
	EnumerateDevicesFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to enumerate devices: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

const recordingKeys = defineKeys({
	devices: ['recorder', 'devices'],
});

/**
 * Surface the outcome of acquiring a recording device. A clean success is
 * silent (the pill is the in-flight feedback). A fallback to a different
 * microphone is a standing config notice the pill cannot carry, so it is
 * reported here, and the chosen device is persisted so the next session keeps
 * it.
 */
function reportDeviceAcquisitionOutcome(
	outcome: DeviceAcquisitionOutcome,
	persist: (deviceId: string) => void,
): void {
	if (outcome.outcome === 'success') return;

	persist(outcome.deviceId);
	switch (outcome.reason) {
		case 'no-device-selected':
			report.info({
				title: 'Switched to available microphone',
				description:
					'No microphone was selected, so we automatically connected to an available one. You can update your selection in settings.',
				action: {
					label: 'Open Settings',
					onClick: () => goto(resolve('/settings/recording')),
				},
			});
			return;
		case 'preferred-device-unavailable':
			report.info({
				title: 'Switched to different microphone',
				description:
					"Your previously selected microphone wasn't found, so we automatically connected to an available one.",
				action: {
					label: 'Open Settings',
					onClick: () => goto(resolve('/settings/recording')),
				},
			});
			return;
	}
}

/**
 * What to say when a capture ends on its own. Each reason has a different
 * recovery, which is the whole reason the host distinguishes them.
 *
 * Each one says what happened to the *capture* and stops there. Saying the audio
 * was kept would be promising an outcome nobody knows yet: claiming it runs
 * through the ordinary stop, and a stop can still fail, most plausibly for
 * `storageFailed`, where the disk that could not take the samples may not take
 * the header patch either. The stop's own receipt (a transcript landing, or the
 * failure the pipeline reports) is what tells the person how it went.
 */
const ENDED_NOTICE: Record<RecordingEndedReason, string> = {
	deviceDisconnected: 'Your microphone disconnected, so the recording stopped.',
	permissionRevoked:
		'Microphone access was turned off, so the recording stopped.',
	streamFailed: 'Your microphone stopped working, so the recording stopped.',
	storageFailed:
		"Epicenter couldn't keep writing the recording to disk, so it stopped.",
};

/** One UI session's saved-recording workflow over its framework capture service. */
export function createWhisperingRecording(
	app: WhisperingApp,
	service: RecordingService,
) {
	let disposed = false;
	let currentCapture = $state.raw<Recording | null>(null);
	let pendingStart = $state.raw<Promise<void> | null>(null);
	let uncertainStart = $state(false);
	let cancelling = false;
	let stopEndedListener: (() => void) | null = null;
	let stopLevelListener: (() => void) | null = null;
	let currentFeedback: (() => boolean) | undefined;
	const recordings = app.recordings;
	let captured:
		| {
				recordedAt: ReturnType<typeof InstantString.now>;
				recordedAtZone: string;
				transcribe: ReturnType<typeof captureTranscription>;
		  }
		| undefined;
	let finishing = $state(false);
	let saveStatus = $state<
		'idle' | 'saving' | 'saved' | 'unconfirmed' | 'failed'
	>('idle');

	function hold(recording: Recording, feedback = dictationLifecycle.reset()) {
		release();
		currentCapture = recording;
		currentFeedback = feedback;
		// Feedback follows the exact live session.
		stopLevelListener = recording.onLevel(reportRecordingMicLevel);
		// The one ending a live caller cannot infer from its own calls: the
		// capture died. Everything else that clears `currentCapture` is a consequence
		// of something this module asked for.
		//
		// The recording is deliberately *not* released here. Its capture is over
		// but it still holds what it recorded, and dropping it would strand that
		// audio in a host slot nothing could ever claim. Resolving it is the
		// handler's job, through the ordinary stop or cancel.
		//
		// One subscription covers every way a capture can end, including one that
		// already had when this recording was handed over: `onEnded` announces
		// that too, so nothing here has to ask which way it found out.
		stopEndedListener = recording.onEnded((reason) => {
			if (disposed || !app.recordingEnabled || currentCapture !== recording)
				return;
			const { error } = RecorderError.RecorderFailed({
				cause: ENDED_NOTICE[reason],
			});
			report.error({ title: 'Recording stopped', cause: error });
			void stop(recording.id);
		});
	}

	function release() {
		stopLevelListener?.();
		stopLevelListener = null;
		stopEndedListener?.();
		stopEndedListener = null;
		currentCapture = null;
	}

	async function startCapture(feedback: () => boolean) {
		if (disposed) return RecorderError.NoActiveRecording();
		if (pendingStart !== null || currentCapture || finishing || cancelling)
			return RecorderError.AlreadyRecording();
		const completion = Promise.withResolvers<void>();
		pendingStart = completion.promise;
		try {
			const params = manualRecorderConfig.resolveStartParams();
			if (!uncertainStart || !captured)
				captured = {
					recordedAt: InstantString.now(),
					recordedAtZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					transcribe: captureTranscription(app),
				};
			saveStatus = 'idle';
			if (disposed || !app.recordingEnabled)
				return RecorderError.NoActiveRecording();
			const { data: recording, error: startError } = await service.start({
				...params,
			});
			if (startError) {
				uncertainStart = startError.name === 'StartUnconfirmed';
				if (!uncertainStart) captured = undefined;
				return Err(startError);
			}
			uncertainStart = false;

			if (disposed || !app.recordingEnabled) {
				const cleanup = await recording.cancel();
				return cleanup.error
					? Err(cleanup.error)
					: RecorderError.NoActiveRecording();
			}
			hold(recording, feedback);
			return Ok(recording);
		} finally {
			pendingStart = null;
			completion.resolve();
		}
	}

	async function stopCapture() {
		if (pendingStart !== null) await pendingStart;
		if (disposed || finishing || cancelling)
			return RecorderError.NoActiveRecording();
		const recording = currentCapture;
		const metadata = captured;
		if (!recording || !metadata) return RecorderError.NoActiveRecording();
		const isCurrentAttempt = currentFeedback;
		finishing = true;
		try {
			const result = await recording.stop();
			if (result.error) {
				if (
					result.error.name === 'CaptureLost' ||
					result.error.name === 'NoActiveRecording'
				) {
					release();
					captured = undefined;
					saveStatus = 'failed';
				}
				return result;
			}
			release();
			captured = undefined;
			saveStatus = 'saving';
			try {
				if (disposed || app.signal.aborted || !app.recordingEnabled) {
					saveStatus = 'unconfirmed';
					return RecorderError.NoActiveRecording();
				}
				const saved = await recordings.create({
					audioBlobId: result.data.blobId,
					title: '',
					recordedAt: metadata.recordedAt,
					recordedAtZone: metadata.recordedAtZone,
					transcript: '',
					polishedTranscript: null,
					duration: result.data.durationMs,
				});
				if (saved.error) {
					saveStatus = 'unconfirmed';
					return saved;
				}
				saveStatus = 'saved';
				return Ok({
					durationMs: result.data.durationMs,
					byteLength: result.data.byteLength,
					recordingId: saved.data.id,
					isCurrentAttempt,
					transcribe: metadata.transcribe,
				});
			} finally {
				if (saveStatus === 'saving') saveStatus = 'unconfirmed';
			}
		} finally {
			finishing = false;
		}
	}

	async function start(): Promise<string | null> {
		if (!app.recordingEnabled) return null;
		if (pendingStart !== null || currentCapture || finishing || cancelling)
			return null;
		return trackRecordingWork(async () => {
			app.settings.set('recordingTrigger', 'manual');
			// A new dictation is starting: clear any lingering failed/delivered state so
			// the pill follows this attempt, not the last one.
			const feedback = dictationLifecycle.reset();
			// A capture just started, so leave the import overlay if it was open: the
			// surface should follow the live recording, not stay parked on import.
			captureSurface.dismissImport();

			// Manual owns playback for the whole recording; drop any leftover VAD
			// per-utterance resume so it cannot fire mid-recording.
			cancelPendingVadResume();
			recordingMedia.pause(app);

			const { data: recording, error } = await startCapture(feedback);

			if (error) {
				void recordingMedia.resume();
				if (uncertainStart)
					report.error({
						title: 'Microphone status unknown',
						description: 'Retry to check the recording, or cancel it.',
						cause: error,
						action: {
							label: 'Cancel recording',
							onClick: () => {
								void cancel();
							},
						},
					});
				// An unresolved start retains this workflow until retry or Cancel.
				// No start failure is a confirmed saved recording.
				if (feedback() && !app.signal.aborted)
					dictationLifecycle.markFailed({ tier: 'silent-loss', error });
				return null;
			}

			// The pill shows the live recording; only a device fallback needs a notice.
			reportDeviceAcquisitionOutcome(recording.device, (deviceId) => {
				manualRecorderConfig.deviceId = deviceId;
			});

			log.info('Recording started');
			void playSoundIfEnabled(app, 'manual-start');
			return currentCapture?.id ?? null;
		});
	}

	async function stop(recordingId?: string) {
		// A delayed push-to-talk release can only resolve the capture it started.
		if (
			recordingId !== undefined &&
			(currentCapture?.id ?? null) !== recordingId
		)
			return;
		if (!app.recordingEnabled) return;
		return trackRecordingWork(async () => {
			const feedback = currentFeedback;
			const { data: source, error } = await stopCapture();

			if (error) {
				void recordingMedia.resume();
				if (saveStatus === 'failed')
					report.error({ title: 'Recording could not be saved', cause: error });
				if (saveStatus === 'unconfirmed')
					report.error({ title: 'Recording save not confirmed', cause: error });
				// Finalizing failed, so the captured audio never reached a row: treat it
				// as a silent loss rather than a retryable transcription.
				if (feedback?.() && !app.signal.aborted)
					dictationLifecycle.markFailed({ tier: 'silent-loss', error });
				return;
			}

			const { recordingId: rowId, durationMs, byteLength } = source;

			// The pill carries "stopped -> transcribing"; the transcript landing is the
			// receipt. No per-step toast.
			log.info('Recording stopped');
			void playSoundIfEnabled(app, 'manual-stop');
			void recordingMedia.resume();

			void logAnalyticsEvent(app, {
				type: 'manual_recording_completed',
				blob_size: byteLength,
				duration: durationMs,
			});

			await processRecordingPipeline(app, {
				recordingId: rowId,
				durationMs,
				isCurrentAttempt: source.isCurrentAttempt,
				transcribe: source.transcribe,
			});
		});
	}

	/** Resolve an uncertain native start before cancelling its original capture. */
	async function cancel(): Promise<boolean> {
		if (!app.recordingEnabled) return false;
		if (cancelling) return true;
		cancelling = true;
		try {
			return await trackRecordingWork(async () => {
				if (pendingStart !== null) await pendingStart;
				if (disposed || finishing) return true;
				let recording = currentCapture;
				if (!recording && uncertainStart) {
					const current = await service.current();
					if (current.error) {
						report.error({
							title: 'Could not check the microphone',
							cause: current.error,
						});
						return true;
					}
					recording = current.data;
					if (recording) hold(recording);
					else {
						uncertainStart = false;
						captured = undefined;
						return true;
					}
				}
				if (!recording) return false;
				const { error } = await recording.cancel();
				if (error && error.name !== 'NoActiveRecording') {
					report.error({ title: 'Failed to cancel recording', cause: error });
					return true;
				}
				release();
				uncertainStart = false;
				captured = undefined;
				void recordingMedia.resume();
				void playSoundIfEnabled(app, 'manual-cancel');
				log.info('Recording cancelled');
				return true;
			});
		} finally {
			cancelling = false;
		}
	}

	return {
		recording: {
			get state(): WhisperingRecordingState {
				return currentCapture ? 'RECORDING' : 'IDLE';
			},
			get isStarting() {
				return pendingStart !== null;
			},
			get isUncertain() {
				return uncertainStart;
			},
			get saveStatus() {
				return saveStatus;
			},
			get isSaving() {
				return finishing;
			},
			enumerateDevices() {
				return resultQueryOptions({
					queryKey: recordingKeys.devices,
					queryFn: async () => {
						const { data, error } = await service.enumerateDevices();
						if (error)
							return RecordingDeviceError.EnumerateDevicesFailed({
								cause: error,
							});
						return Ok(data);
					},
				});
			},

			start,
			/** Finalize, save an owning row, and transcribe. An ID restricts this to that capture. */
			stop,
			toggle() {
				return currentCapture ? stop() : start();
			},
			/** Discard saved-recording capture. False means there was none to cancel. */
			cancel,
		},
		[Symbol.dispose]() {
			disposed = true;
			release();
		},
	};
}

export type WhisperingRecording = ReturnType<
	typeof createWhisperingRecording
>['recording'];

/** Admission is already closed. Finish saves and release the separate VAD engine. */
export async function closeRecordingWork() {
	try {
		await drainRecordingWork();
	} finally {
		try {
			if (vadRecorder.state !== 'IDLE') {
				const result = await vadRecorder.stopActiveListening();
				// A failed VAD release must remain visible so UI cleanup can retry it.
				// biome-ignore lint/correctness/noUnsafeFinally: release failure takes precedence over a drained operation failure
				if (result.error) throw result.error;
			}
		} finally {
			resumePlaybackForVadEnd();
		}
	}
}

function isVadRecordingActive() {
	return (
		vadRecorder.state === 'LISTENING' || vadRecorder.state === 'SPEECH_DETECTED'
	);
}

/** The global cancel command also disarms voice-activated capture when needed. */
export async function cancelRecording(app: WhisperingApp) {
	if (!app.recordingEnabled) return;
	if (!(await app.recording.cancel()) && isVadRecordingActive())
		await stopVadRecording(app);
}

// VAD pauses playback per utterance (the speaking window), not for the whole
// armed session: music keeps playing while you are armed-and-silent and stops
// only while you actually speak. A return to listening (speech end or a misfire)
// schedules a debounced resume so back-to-back utterances do not flutter the
// music; the next speech start cancels that pending resume. Ending the session
// resumes immediately. See ADR-0027.
let vadResumeTimer: ReturnType<typeof setTimeout> | undefined;
const VAD_RESUME_DELAY_MS = 1500;

function pausePlaybackForSpeech(app: WhisperingApp) {
	clearTimeout(vadResumeTimer);
	vadResumeTimer = undefined;
	recordingMedia.pause(app);
}

function scheduleResumeAfterSpeech() {
	clearTimeout(vadResumeTimer);
	vadResumeTimer = setTimeout(() => {
		vadResumeTimer = undefined;
		void recordingMedia.resume();
	}, VAD_RESUME_DELAY_MS);
}

/** Resume now and drop any pending debounce: the VAD session is ending. */
function resumePlaybackForVadEnd() {
	clearTimeout(vadResumeTimer);
	vadResumeTimer = undefined;
	void recordingMedia.resume();
}

/**
 * Drop a pending VAD resume without resuming. Used when a manual recording
 * starts: manual owns playback for its whole window, so a debounce left over
 * from a prior VAD utterance must not fire and resume music mid-recording.
 */
function cancelPendingVadResume() {
	clearTimeout(vadResumeTimer);
	vadResumeTimer = undefined;
}

export async function startVadRecording(app: WhisperingApp) {
	if (!app.recordingEnabled) return;
	return trackRecordingWork(async () => {
		app.settings.set('recordingTrigger', 'vad');
		// A new dictation session is starting: clear any lingering terminal state.
		let feedback = dictationLifecycle.reset();
		let transcribe = captureTranscription(app);
		// A capture just started, so leave the import overlay if it was open (see
		// recording.start).
		captureSurface.dismissImport();

		log.info('Starting voice activated capture');

		const { data: outcome, error } = await vadRecorder.startActiveListening({
			onLevel: (level) => {
				if (app.recordingEnabled) reportRecordingMicLevel(level);
			},
			onSpeechStart: () => {
				if (!app.recordingEnabled) return;
				feedback = dictationLifecycle.reset();
				transcribe = captureTranscription(app);
				// Speaking window opened: pause whatever is playing. The pill's meter
				// tint shows speech was detected, so there is no toast.
				pausePlaybackForSpeech(app);
			},
			onSpeechEnd: async (blob) => {
				if (!app.recordingEnabled) return;
				const isCurrentAttempt = feedback;
				const capturedTranscription = transcribe;
				return trackRecordingWork(async () => {
					// Speaking window closed: resume after a short debounce so a quick
					// next utterance does not flutter the music.
					scheduleResumeAfterSpeech();
					log.info('Voice activated speech captured');
					void playSoundIfEnabled(app, 'vad-capture');

					void logAnalyticsEvent(app, {
						type: 'vad_recording_completed',
						blob_size: blob.size,
					});

					await processRecordingPipeline(app, {
						audio: blob,
						durationMs: null,
						isCurrentAttempt,
						transcribe: capturedTranscription,
					});
				});
			},
			onVADMisfire: () => {
				if (!app.recordingEnabled) return;
				// False start: schedule the same debounced resume as a real speech
				// end, so an immediate retry does not flutter the music.
				scheduleResumeAfterSpeech();
			},
		});

		if (error) {
			resumePlaybackForVadEnd();
			// Listening never armed, so nothing was captured: a silent loss.
			if (feedback() && !app.signal.aborted)
				dictationLifecycle.markFailed({ tier: 'silent-loss', error });
			return;
		}

		// The pill shows the armed session; only a device fallback needs a notice.
		reportDeviceAcquisitionOutcome(outcome, (deviceId) =>
			deviceConfig.set('recording.navigator.deviceId', deviceId),
		);

		void playSoundIfEnabled(app, 'vad-start');
	});
}

export async function stopVadRecording(app: WhisperingApp) {
	if (!app.recordingEnabled) return;
	if (!isVadRecordingActive()) return;
	return trackRecordingWork(async () => {
		log.info('Stopping voice activated capture');
		const { data, error } = await vadRecorder.stopActiveListening();
		// Disarming ends the session: restore playback now, do not wait on the
		// per-utterance debounce.
		resumePlaybackForVadEnd();
		if (error) {
			// Stop is an operation with no capture/outcome phase, so the pill cannot
			// carry it: a failed disarm keeps a toast (ADR-0039's operation-condition
			// carve-out). The session may still be live, so the user must know it did
			// not stop.
			report.error({
				title: "Couldn't stop voice activated capture",
				description: 'The session may still be running. Try stopping it again.',
				cause: error,
			});
			return;
		}
		if (data.status === 'idle') return;
		void playSoundIfEnabled(app, 'vad-stop');
	});
}

export function toggleVadRecording(app: WhisperingApp) {
	if (isVadRecordingActive()) {
		return stopVadRecording(app);
	}
	return startVadRecording(app);
}

/**
 * Select a capture surface from the homepage tabs or the header dropdown.
 * `import` opens the transient import overlay without touching
 * `recordingTrigger`; `manual`/`vad` close the overlay and switch the durable
 * trigger. Either way, a live capture on a different surface is stopped first so
 * two captures never overlap (`import` keeps neither recorder, so both stop).
 */
export async function selectCaptureSurface(
	app: WhisperingApp,
	surface: CaptureSurface,
) {
	// Flip the surface first so the tab/dropdown responds instantly; the live
	// capture stopped below finalizes and transcribes in the background rather
	// than blocking the switch.
	if (surface === 'import') {
		captureSurface.showImport();
	} else {
		captureSurface.dismissImport();
		if (app.settings.get('recordingTrigger') !== surface) {
			app.settings.set('recordingTrigger', surface);
		}
	}

	// Stop a live capture on a different surface so two captures never overlap
	// (`import` keeps neither recorder, so both stop). Stopping finalizes it: a
	// manual recording is saved and transcribed, and a voice-activated utterance
	// in progress is flushed through the pipeline (the VAD runs with
	// `submitUserSpeechOnPause`), so nothing you already said is lost.
	if (surface !== 'manual' && app.recording.state === 'RECORDING') {
		await app.recording.stop();
	}
	if (surface !== 'vad' && isVadRecordingActive()) {
		await stopVadRecording(app);
	}
}
