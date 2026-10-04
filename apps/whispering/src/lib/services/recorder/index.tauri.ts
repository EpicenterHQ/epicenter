import { type BlobId, parseBlobId } from '@epicenter/blobs';
import {
	asDeviceIdentifier,
	type Device,
	type DeviceAcquisitionOutcome,
} from '@epicenter/recorder';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { BlobsLive } from '#platform/blobs';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { recorderErrorFromIpc } from '$lib/services/recorder/categorize-error';
import {
	type BaseRecordingParams,
	RecorderError,
	type RecorderService,
	type RecordingSession,
} from '$lib/services/recorder/contract';
import { commands } from '$lib/tauri/commands';
// This file is the Tauri impl, so it imports the non-null capability bag
// directly from the Tauri marker rather than through the `#platform/tauri`
// seam (which resolves to `null` under the web condition).
import { tauriOnly } from '$lib/tauri.tauri';

const log = createLogger('whispering/recorder/cpal');

/**
 * Native (Rust/CPAL) recording parameters. Whispering-owned: the package
 * defines only the base params; the native sample-rate knob is this app's.
 */
export type CpalRecordingParams = BaseRecordingParams & {
	sampleRate: string;
};

async function getMicrophonePermissionStatus(): Promise<
	Result<boolean, RecorderError>
> {
	const { data: granted, error } =
		await tauriOnly.permissions.microphone.check();
	if (error) {
		return RecorderError.MicrophonePermissionDenied({ cause: error });
	}
	return Ok(granted);
}

async function requireMicrophonePermission(): Promise<
	Result<void, RecorderError>
> {
	const { data: granted, error } = await getMicrophonePermissionStatus();
	if (error) return Err(error);
	if (granted) return Ok(undefined);

	return RecorderError.MicrophonePermissionDenied();
}

async function requestMicrophonePermission(): Promise<
	Result<void, RecorderError>
> {
	const { data: alreadyGranted, error: checkError } =
		await getMicrophonePermissionStatus();
	if (checkError) return Err(checkError);
	if (alreadyGranted) return Ok(undefined);

	const { error: requestError } =
		await tauriOnly.permissions.microphone.request();
	if (requestError) {
		return RecorderError.MicrophonePermissionDenied({ cause: requestError });
	}

	const { data: grantedAfterRequest, error: recheckError } =
		await getMicrophonePermissionStatus();
	if (recheckError) return Err(recheckError);
	if (!grantedAfterRequest) return RecorderError.MicrophonePermissionDenied();

	return Ok(undefined);
}

/**
 * Enumerates available recording devices from the system.
 */
const enumerateDevices = async (): Promise<Result<Device[], RecorderError>> => {
	const { error: permissionError } = await requireMicrophonePermission();
	if (permissionError) return Err(permissionError);

	const { data: deviceNames, error: enumerateRecordingDevicesError } =
		await commands.enumerateRecordingDevices();
	if (enumerateRecordingDevicesError !== null) {
		return (
			recorderErrorFromIpc(enumerateRecordingDevicesError) ??
			RecorderError.EnumerateDevices({
				cause: enumerateRecordingDevicesError,
			})
		);
	}
	// On desktop, device names serve as both ID and label
	return Ok(
		deviceNames.map((name) => ({
			id: asDeviceIdentifier(name),
			label: name,
		})),
	);
};

/**
 * CPAL recorder service that uses the Rust CPAL backend.
 *
 * Constructed via a factory so the per-session lifecycle (stop/cancel/
 * subscribe) lives on the returned `RecordingSession`. The service itself
 * only holds a pointer to the active session for reload recovery through
 * `resumeActiveSession`; once stop/cancel runs, that pointer clears.
 *
 * Unlike navigator, a cpal session can outlive a JS reload because the
 * Rust process keeps the cpal stream alive. `resumeActiveSession` consults
 * Rust via `get_current_recording_id` and reattaches a new
 * `RecordingSession` wrapper if Rust still has one going.
 *
 * Stop atomically finalizes the durable WAV under `<appDataDir>/blobs/{id}`
 * and returns only its blob id. There is no raw PCM on the wire.
 */
function createCpalRecorder() {
	let activeSession: RecordingSession | null = null;

	function buildSession(audioBlobId: BlobId, startedAtMs: number | null) {
		const subscribers = new Set<(s: WhisperingRecordingState) => void>();
		let currentState: WhisperingRecordingState = 'RECORDING';
		let tauriUnlisten: Promise<UnlistenFn> | null = null;

		const notify = (state: WhisperingRecordingState) => {
			// Idempotent: same-state notifications collapse to a no-op. Rust
			// emits 'recorder:state-changed' IDLE from `stop_recording`, then
			// our explicit `teardown()` also notifies IDLE; without this
			// guard we'd fire the handler twice for one transition.
			if (currentState === state) return;
			currentState = state;
			for (const handler of subscribers) handler(state);
		};

		const ensureTauriListener = () => {
			if (tauriUnlisten) return;
			// Rust emits 'recorder:state-changed' from every mutation path
			// (see src-tauri/src/recorder/commands.rs). Forward to subscribers
			// so Rust-initiated transitions (future auto-stop, device
			// disconnect) reach the UI.
			tauriUnlisten = listen<WhisperingRecordingState>(
				'recorder:state-changed',
				(event) => notify(event.payload),
			);
		};

		// Takes `session` as an argument rather than closing over the const
		// declared below. Both work because teardown only runs from
		// stop/cancel handlers (which can only fire after `session` is
		// bound), but the explicit argument keeps the function TDZ-safe if a
		// future caller invokes teardown from a path declared above the
		// `session = ...` initializer.
		const teardown = (session: RecordingSession) => {
			if (activeSession === session) activeSession = null;
			if (tauriUnlisten) {
				void tauriUnlisten.then((unlisten) => unlisten());
				tauriUnlisten = null;
			}
			notify('IDLE');
		};

		const session = {
			audioBlobId,

			stop: async () => {
				const { data: returnedId, error: stopRecordingError } =
					await commands.stopRecording();
				if (stopRecordingError !== null) {
					const { error: closeError } = await commands.closeRecordingSession();
					if (closeError !== null)
						log.error(RecorderError.StopFailed({ cause: closeError }));
					teardown(session);
					return RecorderError.StopFailed({ cause: stopRecordingError });
				}

				// Rust's `stop_recording` returns only the committed blob id but does
				// not close the worker; we still own the cpal stream and the
				// worker thread. Send `close_recording_session` so Rust can
				// join the worker and free the stream.
				const { error: closeError } = await commands.closeRecordingSession();
				if (closeError !== null)
					log.error(RecorderError.StopFailed({ cause: closeError }));
				teardown(session);
				const parsedId = parseBlobId(returnedId);
				if (parsedId !== audioBlobId) {
					return RecorderError.StopFailed({
						cause: new Error('Native recorder returned an unexpected blob id.'),
					});
				}
				const { data: blobStat, error: statError } =
					await BlobsLive.stat(audioBlobId);
				if (statError !== null) return Err(statError);

				return Ok({
					audioBlobId,
					durationMs: startedAtMs === null ? null : Date.now() - startedAtMs,
					byteLength: blobStat.size,
				});
			},

			cancel: async () => {
				// cancel_recording on the Rust side discards the in-flight
				// samples and tears down the session worker. One round trip.
				const { error: cancelError } = await commands.cancelRecording();

				// Tear down unconditionally first so the JS-side state can never
				// wedge in RECORDING, even when the Rust cancel failed.
				teardown(session);

				if (cancelError !== null) {
					return RecorderError.CancelFailed({ cause: cancelError });
				}
				return Ok(undefined);
			},

			subscribe(handler) {
				ensureTauriListener();
				subscribers.add(handler);
				// Fire current state immediately so callers don't have to mirror
				// 'RECORDING' at attach time.
				handler(currentState);
				return () => {
					subscribers.delete(handler);
				};
			},
		} satisfies RecordingSession;

		return session;
	}

	return {
		resumeActiveSession: async (): Promise<
			Result<RecordingSession | null, RecorderError>
		> => {
			// If we still hold the in-memory pointer, prefer it; otherwise
			// probe Rust in case a recording session outlived a JS reload.
			if (activeSession) return Ok(activeSession);

			const { data: liveBlobId, error: getIdError } =
				await commands.getCurrentRecordingId();
			if (getIdError !== null) {
				return RecorderError.GetStateFailed({ cause: getIdError });
			}
			if (!liveBlobId) return Ok(null);
			const parsedId = parseBlobId(liveBlobId);
			if (parsedId === undefined) {
				return RecorderError.GetStateFailed({
					cause: new Error('Native recorder returned an invalid blob id.'),
				});
			}

			const rehydrated = buildSession(parsedId, null);
			activeSession = rehydrated;
			return Ok(rehydrated);
		},

		enumerateDevices,

		// Takes only `params`, no callbacks: CPAL drives the pill meter from Rust
		// straight to the overlay window, so it never reads the caller's
		// `onLevel` sink. A params-only function still satisfies the
		// RecorderService contract (a narrower function is assignable to a wider
		// one), and callers reach it through the `RecorderService` contract type
		// the export below publishes, so they still pass both arguments.
		startRecording: async ({
			selectedDeviceId,
			audioBlobId,
			sampleRate,
		}: CpalRecordingParams) => {
			const { error: permissionError } = await requestMicrophonePermission();
			if (permissionError) return Err(permissionError);

			const { data: devices, error: enumerateError } = await enumerateDevices();
			if (enumerateError !== null) return Err(enumerateError);

			const deviceIds = devices.map((d) => d.id);
			const fallbackDeviceId = deviceIds.at(0);
			// Empty device list: there is no microphone to fall back to, whether or
			// not one was previously selected. Same condition, same recovery as a
			// device that vanishes mid-open, so it surfaces the one NoInputDevice.
			if (!fallbackDeviceId) {
				return RecorderError.NoInputDevice();
			}

			const deviceOutcome: DeviceAcquisitionOutcome = (() => {
				if (!selectedDeviceId) {
					return {
						outcome: 'fallback',
						reason: 'no-device-selected',
						deviceId: fallbackDeviceId,
					};
				}

				if (deviceIds.includes(selectedDeviceId)) {
					return { outcome: 'success', deviceId: selectedDeviceId };
				}

				return {
					outcome: 'fallback',
					reason: 'preferred-device-unavailable',
					deviceId: fallbackDeviceId,
				};
			})();

			const deviceIdentifier = deviceOutcome.deviceId;

			const sampleRateNum = sampleRate ? Number.parseInt(sampleRate, 10) : null;

			const { error: initRecordingSessionError } =
				await commands.initRecordingSession(
					deviceIdentifier,
					audioBlobId,
					sampleRateNum,
				);
			if (initRecordingSessionError !== null)
				return (
					recorderErrorFromIpc(initRecordingSessionError) ??
					RecorderError.InitFailed({
						cause: initRecordingSessionError,
					})
				);

			const { error: startRecordingError } = await commands.startRecording();
			if (startRecordingError !== null) {
				// The session was initialized but never started; close it so the
				// Rust worker and cpal stream don't outlive this failed start
				// (mirrors the stop-error cleanup above).
				const { error: closeError } = await commands.closeRecordingSession();
				if (closeError !== null)
					log.error(RecorderError.StartFailed({ cause: closeError }));
				return (
					recorderErrorFromIpc(startRecordingError) ??
					RecorderError.StartFailed({ cause: startRecordingError })
				);
			}

			const session = buildSession(audioBlobId, Date.now());
			activeSession = session;
			return Ok({ session, deviceAcquisition: deviceOutcome });
		},
	} satisfies RecorderService<CpalRecordingParams>;
}

export const ManualRecorderLive: RecorderService<CpalRecordingParams> =
	createCpalRecorder();
