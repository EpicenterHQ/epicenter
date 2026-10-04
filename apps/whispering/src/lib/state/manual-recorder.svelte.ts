import { type BlobId, generateBlobId } from '@epicenter/blobs';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { defineKeys, resultQueryOptions } from 'wellcrafted/query';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { manualRecorderConfig } from '#platform/manual-recorder-config';
import { ManualRecorderLive } from '#platform/recorder';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import type {
	RecorderError,
	RecordingCallbacks,
	RecordingSession,
} from '$lib/services/recorder/contract';

const ManualRecorderError = defineErrors({
	EnumerateDevicesFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to enumerate devices: ${extractErrorMessage(cause)}`,
		cause,
	}),
	AlreadyRecording: () => ({
		message:
			'A recording is already in progress. Stop the current one before starting a new one.',
	}),
	NoActiveRecording: () => ({
		message: 'No active recording session to stop. Start a recording first.',
	}),
});

const manualRecorderKeys = defineKeys({
	devices: ['recorder', 'devices'],
});

/**
 * Creates the manual recorder with reactive state.
 *
 * State is owned by this module via Svelte's `$state` rune for synchronous
 * reactivity. Mirrors the shape of `vadRecorder` in `vad-recorder.svelte.ts`:
 *
 * - Reactive access: `manualRecorder.state` (triggers effects on change)
 * - Operations: `manualRecorder.startRecording()` etc.
 * - Device enumeration as a TanStack Query for loading states in selectors
 *
 * Each recording is a `RecordingSession` object returned by the implementation
 * that started it. The RecordingSession owns its own stop/cancel/subscribe.
 *
 * Subscription is per-RecordingSession rather than per-service. `attach()`
 * subscribes to the live RecordingSession and `detach()` cleans up on
 * stop/cancel.
 *
 * On Tauri, state is bootstrapped from CPAL's `resumeActiveSession` before
 * the first lifecycle operation because a Rust CPAL session can outlive a JS
 * reload. On web, the Navigator recorder returns null after reload.
 */

function createManualRecorder() {
	let _state = $state<WhisperingRecordingState>('IDLE');
	let _current: RecordingSession | null = null;
	// The blob id reserved for the live recording and its future workspace row.
	// Null when idle; set while recording. The push-to-talk stop path reads it to
	// stop only the exact recording it started, never one a later press supplanted.
	let _currentAudioBlobId: BlobId | null = null;
	let _unsubscribe: (() => void) | null = null;
	// Synchronous in-flight guard for start. `_current` is not set until after
	// two awaits (bootstrap + the service start), so without this a second
	// start firing in that window (e.g. a global shortcut pressed twice) would
	// pass the `_current` check and orphan a second recording.
	let _starting = false;

	function attach(session: RecordingSession) {
		_unsubscribe?.();
		_current = session;
		_unsubscribe = session.subscribe((s) => {
			_state = s;
			if (s === 'IDLE') detach();
		});
	}

	function detach() {
		_unsubscribe?.();
		_unsubscribe = null;
		_current = null;
		_currentAudioBlobId = null;
		_state = 'IDLE';
	}

	// Bootstrap: ask the platform recorder whether it owns a live session.
	// Navigator always returns null after a JS reload because its state lives
	// in the closure; CPAL can return non-null because Rust keeps the stream
	// alive.
	//
	// The promise is awaited before any stop/cancel/start runs. Without
	// that gate, a user action that fires before bootstrap resolves sees a
	// stale `_current === null` and either no-ops the cancel (leaking the
	// Rust session) or double-starts on top of a rehydrated one.
	let bootstrapped: Promise<Result<void, RecorderError>> | null = null;

	function ensureBootstrapped() {
		bootstrapped ??= ManualRecorderLive.resumeActiveSession().then((result) => {
			const { data: found, error } = result;
			if (error) {
				bootstrapped = null;
				return Err(error);
			}
			if (found) attach(found);
			return Ok(undefined);
		});
		return bootstrapped;
	}

	return {
		get state(): WhisperingRecordingState {
			return _state;
		},

		/** The live recording's id (only set while `state` is RECORDING, else null). */
		get currentAudioBlobId(): BlobId | null {
			return _currentAudioBlobId;
		},

		/** True between a start request and the recording attaching (or failing). */
		get isStarting(): boolean {
			return _starting;
		},

		enumerateDevices: {
			options: resultQueryOptions({
				queryKey: manualRecorderKeys.devices,
				queryFn: async () => {
					const { data, error } = await ManualRecorderLive.enumerateDevices();
					if (error)
						return ManualRecorderError.EnumerateDevicesFailed({ cause: error });
					return Ok(data);
				},
			}),
		},

		async startRecording(callbacks: RecordingCallbacks) {
			if (_starting) return ManualRecorderError.AlreadyRecording();
			_starting = true;
			try {
				// Bootstrap may rehydrate a CPAL session that outlived a reload,
				// so the `_current` check has to come after it.
				const { error: bootstrapError } = await ensureBootstrapped();
				if (bootstrapError) return Err(bootstrapError);
				if (_current) return ManualRecorderError.AlreadyRecording();
				const audioBlobId = generateBlobId();
				const params = manualRecorderConfig.resolveStartParams(audioBlobId);
				const { data, error: startRecordingError } =
					await ManualRecorderLive.startRecording(params, callbacks);

				if (startRecordingError) return Err(startRecordingError);

				_currentAudioBlobId = audioBlobId;
				attach(data.session);
				return Ok(data.deviceAcquisition);
			} finally {
				_starting = false;
			}
		},

		async stopRecording() {
			const { error: bootstrapError } = await ensureBootstrapped();
			if (bootstrapError) return Err(bootstrapError);
			if (!_current) return ManualRecorderError.NoActiveRecording();
			return _current.stop();
		},

		async cancelRecording() {
			const { error: bootstrapError } = await ensureBootstrapped();
			if (bootstrapError) return Err(bootstrapError);
			if (!_current) return Ok({ status: 'no-recording' as const });
			const { error } = await _current.cancel();
			if (error) return Err(error);
			return Ok({ status: 'cancelled' as const });
		},
	};
}

export const manualRecorder = createManualRecorder();
