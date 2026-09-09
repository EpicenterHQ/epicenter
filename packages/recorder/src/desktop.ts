import { captureLibraryReplica } from '@epicenter/principal';
import { parseBlobId } from '@epicenter/blobs';
import { blobDestination } from '@epicenter/blobs/native';
import { isAppId } from '@epicenter/constants/app-id';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import {
	asDeviceIdentifier,
	type DeviceAcquisitionOutcome,
} from '@epicenter/recorder';
import {
	RecorderError,
	type RecordingReplica,
	type Recording,
	type RecordingEndedReason,
	type RecordingOwner,
	type RecordingOptions,
	type NativeRecording,
} from './recording.js';

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
	input: RecordingReplica,
	{ assertUsable, canRecover = () => false }: RecordingOptions,
): RecordingOwner {
	if (!isAppId(appId)) throw new Error(`Invalid recording app ID '${appId}'.`);
	const replica = captureLibraryReplica(input);
	let closed = false;
	let closing: Promise<void> | undefined;
	const operations = new Set<Promise<unknown>>();
	const cleanupErrors: unknown[] = [];
	function assertOpen() {
		if (closed) throw new Error('Recording is closed.');
		assertUsable?.();
	}
	function run<T>(operation: () => Promise<T>): Promise<T> {
		assertOpen();
		const completion = Promise.withResolvers<T>();
		operations.add(completion.promise);
		void completion.promise.then(
			() => operations.delete(completion.promise),
			(cause) => {
				operations.delete(completion.promise);
				cleanupErrors.push(cause);
			},
		);
		try {
			completion.resolve(operation());
		} catch (cause) {
			completion.reject(cause);
		}
		return completion.promise;
	}

	const destination = blobDestination(appId, replica);
	let held:
		| {
				recording: Recording;
				reconcile(reason: RecordingEndedReason | null): void;
				cancel(): Promise<Result<void, RecorderError>>;
		  }
		| undefined;

	function wrap(live: NativeRecording): Result<Recording, RecorderError> {
		const audioBlobId = parseBlobId(live.audioBlobId);
		if (audioBlobId === undefined)
			return RecorderError.RecorderFailed({
				cause: new Error('The host returned an invalid blob ID.'),
			});
		const captured = live.destination.replica;
		const matches =
			captured.library === 'local'
				? replica.library === 'local'
				: replica.library === captured.library &&
					captured.account.authorityId === replica.account.authorityId &&
					captured.account.principalId === replica.account.principalId;
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

		const releases = new Set<Promise<void>>();
		function unlisten(promise: Promise<UnlistenFn>) {
			const release = promise.then((stop) => stop());
			releases.add(release);
			void release.then(
				() => releases.delete(release),
				(cause) => {
					releases.delete(release);
					cleanupErrors.push(cause);
				},
			);
		}
		async function release() {
			for (const listener of unlisteners) unlisten(listener);
			unlisteners.clear();
			await Promise.allSettled(releases);
		}
		function track(promise: Promise<UnlistenFn>) {
			unlisteners.add(promise);
			void promise.catch(() => {}); // release owns registration failures.
			return () => {
				if (unlisteners.delete(promise)) unlisten(promise);
			};
		}
		async function cancel() {
			resolved = true;
			const result = await call<void>('cancel_recording', { audioBlobId });
			await release();
			if (
				(result.error === null || result.error.name === 'NoActiveRecording') &&
				held?.recording.audioBlobId === audioBlobId
			)
				held = undefined;
			return result;
		}
		const recording = Object.freeze({
			audioBlobId,
			replica,
			device,
			get endedReason() {
				return endedReason;
			},
			stop() {
				return run(async () => {
					if (resolved) return RecorderError.NoActiveRecording();
					resolved = true;
					const result = await call<{
						audioBlobId: string;
						durationMs: number;
						byteLength: number;
					}>('stop_recording', { audioBlobId });
					await release();
					if (result.error) return Err(result.error);
					if (result.data.audioBlobId !== audioBlobId)
						return RecorderError.RecorderFailed({
							cause: new Error('The host stopped a different recording.'),
						});
					if (held?.recording.audioBlobId === audioBlobId) held = undefined;
					return Ok({ ...result.data, audioBlobId });
				});
			},
			cancel() {
				return run(async () => {
					if (resolved) return RecorderError.NoActiveRecording();
					return cancel();
				});
			},
			onLevel(handler) {
				assertOpen();
				if (resolved || endedReason !== null) return () => {};
				let subscribed = true;
				const stop = track(
					listen<number>('mic-level', (event) => {
						if (!closed && subscribed && !resolved && endedReason === null)
							handler(event.payload);
					}),
				);
				return () => {
					subscribed = false;
					stop();
				};
			},
			onEnded(handler) {
				assertOpen();
				if (resolved) return () => {};
				let subscribed = true;
				let announced = false;
				const announce = (reason: RecordingEndedReason) => {
					if (closed || !subscribed || resolved || announced) return;
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
				const reconciliation = listening
					.then(async () => {
						if (closed || !subscribed || resolved || announced) return;
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
				operations.add(reconciliation);
				void reconciliation.finally(() => operations.delete(reconciliation));
				return () => {
					subscribed = false;
					stop();
				};
			},
		} satisfies Recording);
		held = {
			recording,
			cancel,
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
		close() {
			if (closing) return closing;
			closed = true;
			const completion = Promise.withResolvers<void>();
			closing = completion.promise;
			completion.resolve(
				(async () => {
					while (operations.size) await Promise.allSettled(operations);
					if (!held && canRecover()) {
						const result = await call<NativeRecording | null>(
							'current_recording',
						);
						if (result.error !== null) throw result.error;
						if (result.data !== null) {
							const recovered = wrap(result.data);
							if (
								recovered.error !== null &&
								recovered.error.name !== 'AlreadyRecording'
							)
								throw recovered.error;
						}
					}
					if (held) {
						const result = await held.cancel();
						if (
							result.error !== null &&
							result.error.name !== 'NoActiveRecording'
						) {
							if (!cleanupErrors.length) throw result.error;
							cleanupErrors.push(result.error);
						}
					}
					if (cleanupErrors.length)
						throw new AggregateError(
							cleanupErrors,
							'Recording cleanup failed.',
						);
				})(),
			);
			return closing;
		},
		value: {
			current() {
				return run(async () => {
					const result = await call<NativeRecording | null>(
						'current_recording',
					);
					if (result.error) return Err(result.error);
					return result.data === null ? Ok(null) : wrap(result.data);
				});
			},
			enumerateDevices() {
				return run(async () => {
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
				});
			},
			start({ selectedDeviceId = null } = {}) {
				return run(async () => {
					const permitted = await permission('request_microphone_permission');
					if (permitted.error) return permitted;
					const result = await call<NativeRecording>('start_recording', {
						deviceIdentifier: selectedDeviceId,
						destination,
					});
					if (result.error) return Err(result.error);
					return wrap(result.data);
				});
			},
		},
	};
}
