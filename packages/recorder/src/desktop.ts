import { parseBlobId } from '@epicenter/blobs';
import { blobDestination, type BlobDestination } from '@epicenter/blobs/native';
import { isAppId } from '@epicenter/constants/app-id';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import {
	asDeviceIdentifier,
	type DeviceAcquisitionOutcome,
} from './devices.js';
import {
	captureRecordingAccount,
	RecorderError,
	type RecordingAccount,
	type Recording,
	type RecordingEndedReason,
	type RecordingService,
} from './recording.js';

/** Wire shape pinned against the host's generated bindings by the consumer check. */
export type NativeRecording = {
	audioBlobId: string;
	destination: BlobDestination;
	device:
		| { outcome: 'success'; deviceId: string }
		| {
				outcome: 'fallback';
				deviceId: string;
				reason: 'no-device-selected' | 'preferred-device-unavailable';
		  };
	endedReason: RecordingEndedReason | null;
};

const log = createLogger('recorder/desktop');

function nativeFailure(cause: unknown) {
	const name =
		typeof cause === 'object' && cause !== null && 'name' in cause
			? cause.name
			: undefined;
	switch (name) {
		case 'PermissionDenied':
			return RecorderError.MicrophonePermissionDenied({ cause });
		case 'NoInputDevice':
			return RecorderError.NoInputDevice({ cause });
		case 'Busy':
			return RecorderError.AlreadyRecording({ cause });
		case 'NotRecording':
			return RecorderError.NoActiveRecording({ cause });
		default:
			return RecorderError.RecorderFailed({ cause });
	}
}

function call<T>(command: string, args?: Record<string, unknown>) {
	return tryAsync({
		try: () => invoke<T>(command, args),
		catch: nativeFailure,
	});
}

/** Bind the existing host recorder to one application without acquiring resources. */
export function createDesktopRecording(
	appId: string,
	input: RecordingAccount,
): RecordingService {
	if (!isAppId(appId)) throw new Error(`Invalid recording app ID '${appId}'.`);
	const account = captureRecordingAccount(input);
	const destination = blobDestination(appId, account);
	let held:
		| {
				recording: Recording;
				reconcile(reason: RecordingEndedReason | null): void;
		  }
		| undefined;

	function wrap(live: NativeRecording): Result<Recording, RecorderError> {
		const audioBlobId = parseBlobId(live.audioBlobId);
		if (audioBlobId === undefined)
			return RecorderError.RecorderFailed({
				cause: new Error('The host returned an invalid blob ID.'),
			});
		const scope = live.destination.scope;
		const matches =
			scope.kind === 'local'
				? account === null
				: account !== null &&
					scope.authorityId === account.authorityId &&
					scope.principalId === account.principalId;
		if (live.destination.appId !== appId || !matches) {
			return RecorderError.AlreadyRecording({
				cause: new Error('The recording belongs to another dataset.'),
			});
		}
		const device: DeviceAcquisitionOutcome = {
			...live.device,
			deviceId: asDeviceIdentifier(live.device.deviceId),
		};
		if (held?.recording.audioBlobId === audioBlobId) {
			held.reconcile(live.endedReason);
			return Ok(held.recording);
		}
		let endedReason = live.endedReason;
		let resolved = false;
		const unlisteners = new Set<Promise<UnlistenFn>>();

		function unlisten(promise: Promise<UnlistenFn>) {
			void promise
				.then((stop) => stop())
				.catch((cause) =>
					log.warn(RecorderError.RecorderFailed({ cause }).error),
				);
		}
		function release() {
			resolved = true;
			if (held?.recording.audioBlobId === audioBlobId) held = undefined;
			for (const listener of unlisteners) unlisten(listener);
			unlisteners.clear();
		}
		function track(promise: Promise<UnlistenFn>) {
			unlisteners.add(promise);
			void promise.catch((cause) =>
				log.warn(RecorderError.RecorderFailed({ cause }).error),
			);
			return () => {
				if (unlisteners.delete(promise)) unlisten(promise);
			};
		}
		const recording = Object.freeze({
			audioBlobId,
			account,
			device,
			get endedReason() {
				return endedReason;
			},
			async stop() {
				if (resolved) return RecorderError.NoActiveRecording();
				release();
				const result = await call<{
					audioBlobId: string;
					durationMs: number;
					byteLength: number;
				}>('stop_recording', { audioBlobId });
				if (result.error) return Err(result.error);
				if (result.data.audioBlobId !== audioBlobId)
					return RecorderError.RecorderFailed({
						cause: new Error('The host stopped a different recording.'),
					});
				return Ok({ ...result.data, audioBlobId });
			},
			async cancel() {
				if (resolved) return RecorderError.NoActiveRecording();
				release();
				return call<void>('cancel_recording', { audioBlobId });
			},
			onLevel(handler) {
				if (resolved || endedReason !== null) return () => {};
				let subscribed = true;
				const stop = track(
					listen<number>('mic-level', (event) => {
						if (subscribed && !resolved && endedReason === null)
							handler(event.payload);
					}),
				);
				return () => {
					subscribed = false;
					stop();
				};
			},
			onEnded(handler) {
				if (resolved) return () => {};
				let subscribed = true;
				let announced = false;
				const announce = (reason: RecordingEndedReason) => {
					if (!subscribed || resolved || announced) return;
					announced = true;
					endedReason = reason;
					handler(reason);
				};
				if (endedReason !== null) {
					const reason = endedReason;
					queueMicrotask(() => announce(reason));
					return () => {
						subscribed = false;
					};
				}
				const listening = listen<{
					audioBlobId: string;
					reason: RecordingEndedReason;
				}>('recording-ended-event', ({ payload }) => {
					if (payload.audioBlobId === audioBlobId) announce(payload.reason);
				});
				const stop = track(listening);
				// Reconcile after installing the listener: capture may have ended in the gap.
				void listening
					.then(async () => {
						if (!subscribed || resolved || announced) return;
						const current = await call<NativeRecording | null>(
							'current_recording',
						);
						if (
							current.data?.audioBlobId === audioBlobId &&
							current.data.endedReason !== null
						) {
							announce(current.data.endedReason);
						}
					})
					.catch((cause) =>
						log.warn(RecorderError.RecorderFailed({ cause }).error),
					);
				return () => {
					subscribed = false;
					stop();
				};
			},
		} satisfies Recording);
		held = {
			recording,
			reconcile(reason) {
				endedReason ??= reason;
			},
		};
		return Ok(recording);
	}

	async function permission(command: string) {
		const result = await call<string>(command);
		if (result.error) return Err(result.error);
		return result.data === 'granted' || result.data === 'unknown'
			? Ok(undefined)
			: RecorderError.MicrophonePermissionDenied();
	}

	return {
		async current() {
			const result = await call<NativeRecording | null>('current_recording');
			if (result.error) return Err(result.error);
			return result.data === null ? Ok(null) : wrap(result.data);
		},
		async enumerateDevices() {
			const permitted = await permission('get_microphone_permission');
			if (permitted.error) return permitted;
			const result = await call<string[]>('enumerate_recording_devices');
			if (result.error) return Err(result.error);
			return Ok(
				result.data.map((name) => ({
					id: asDeviceIdentifier(name),
					label: name,
				})),
			);
		},
		async start({ selectedDeviceId = null } = {}) {
			const permitted = await permission('request_microphone_permission');
			if (permitted.error) return permitted;
			const result = await call<NativeRecording>('start_recording', {
				deviceIdentifier: selectedDeviceId,
				destination,
			});
			if (result.error) return Err(result.error);
			return wrap(result.data);
		},
	};
}
