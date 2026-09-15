import { parseBlobId } from '@epicenter/blobs';
import { blobDestination } from '@epicenter/blobs/native';
import { isAppId } from '@epicenter/constants/app-id';
import { type Attachment, attachmentEngineOf } from '@epicenter/data/store';
import { captureLibraryReplica } from '@epicenter/principal';
import {
	asDeviceIdentifier,
	type DeviceAcquisitionOutcome,
} from '@epicenter/recorder';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import {
	type NativeRecording,
	RecorderError,
	type Recording,
	type RecordingEndedReason,
	type RecordingOptions,
	type RecordingOwner,
	type RecordingReplica,
} from '../recorder.js';

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
	{
		assertUsable,
		canRecover = () => false,
		resolveAttachment,
		isRetired = () => false,
		generation,
	}: RecordingOptions,
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
	function owns(live: NativeRecording) {
		const captured = live.destination.replica;
		return (
			live.destination.appId === appId &&
			(captured.library === 'local'
				? replica.library === 'local'
				: replica.library === captured.library &&
					captured.account.authorityId === replica.account.authorityId &&
					captured.account.principalId === replica.account.principalId)
		);
	}
	let held:
		| {
				recording: Recording;
				reconcile(reason: RecordingEndedReason | null): void;
				releaseCapture(): Promise<Result<void, RecorderError>>;
				retireCapture(): Promise<Result<void, RecorderError>>;
		  }
		| undefined;

	function wrap(
		live: NativeRecording,
		selected?: Attachment,
	): Result<Recording, RecorderError> {
		const audioBlobId = parseBlobId(live.audioBlobId);
		if (audioBlobId === undefined)
			return RecorderError.RecorderFailed({
				cause: new Error('The host returned an invalid blob ID.'),
			});
		if (!owns(live)) {
			return RecorderError.AlreadyRecording({
				cause: new Error('The recording belongs to another dataset.'),
			});
		}
		const device: DeviceAcquisitionOutcome = {
			...live.device,
			deviceId: asDeviceIdentifier(live.device.deviceId),
		};
		if (held?.recording.id === audioBlobId) {
			held.reconcile(live.endedReason);
			return Ok(held.recording);
		}
		let into: Attachment;
		try {
			const found =
				selected ??
				resolveAttachment?.(live.attachment.tableName, live.attachment.rowId);
			if (!found)
				throw new Error('The recording attachment cannot be resolved.');
			into = found;
			const engine = attachmentEngineOf(into);
			if (
				into.tableName !== live.attachment.tableName ||
				into.rowId !== live.attachment.rowId ||
				engine.generation() !== live.attachment.generation
			)
				throw new Error('The recording belongs to another row or generation.');
		} catch (cause) {
			return RecorderError.RecorderFailed({ cause });
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
		async function cancel(retire = isRetired()) {
			resolved = true;
			const command = retire ? 'retire_recording' : 'cancel_recording';
			const result = await call<void>(command, { audioBlobId, destination });
			await release();
			if (
				(result.error === null || result.error.name === 'NoActiveRecording') &&
				held?.recording.id === audioBlobId
			) {
				held = undefined;
			} else if (result.error) {
				resolved = false;
			}
			return result;
		}
		const recording = Object.freeze({
			id: audioBlobId,
			into,
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
					}>('stop_recording', { audioBlobId, destination });
					await release();
					if (result.error) {
						resolved = false;
						return Err(result.error);
					}
					if (result.data.audioBlobId !== audioBlobId)
						return RecorderError.RecorderFailed({
							cause: new Error('The host stopped a different recording.'),
						});
					const completed =
						await attachmentEngineOf(into).completeFromLocal('audio/wav');
					if (completed.error) {
						resolved = false;
						return Err(completed.error);
					}
					const acknowledged = await call<void>('acknowledge_recording', {
						audioBlobId,
						destination,
					});
					if (acknowledged.error) {
						resolved = false;
						return Err(acknowledged.error);
					}
					if (held?.recording.id === audioBlobId) held = undefined;
					return Ok({
						durationMs: result.data.durationMs,
						byteLength: result.data.byteLength,
					});
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
					listen<{ audioBlobId: string; level: number }>(
						'mic-level',
						(event) => {
							if (
								!closed &&
								subscribed &&
								!resolved &&
								endedReason === null &&
								event.payload.audioBlobId === audioBlobId
							)
								handler(event.payload.level);
						},
					),
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
							{ destination },
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
			retireCapture: () => cancel(true),
			async releaseCapture() {
				if (isRetired()) return cancel();
				resolved = true;
				const result = await call<void>('release_recording', {
					audioBlobId,
					destination,
				});
				await release();
				return result;
			},
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
							{ destination },
						);
						if (result.error !== null) throw result.error;
						if (result.data !== null && owns(result.data)) {
							// The App has already closed its document. Release the native
							// session without reopening or resolving its attachment.
							const recovered = await call<void>(
								isRetired() ? 'retire_recording' : 'release_recording',
								{ audioBlobId: result.data.audioBlobId, destination },
							);
							if (
								recovered.error !== null &&
								recovered.error.name !== 'NoActiveRecording'
							)
								throw recovered.error;
						}
					}
					if (held) {
						const result = await held.releaseCapture();
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
						{ destination },
					);
					if (result.error) return Err(result.error);
					if (result.data === null) return Ok(null);
					const live = result.data;
					if (owns(live)) {
						let obsolete: boolean;
						try {
							const openedGeneration = generation?.();
							obsolete =
								isRetired() ||
								(typeof openedGeneration === 'number' &&
									typeof live.attachment.generation === 'number' &&
									openedGeneration > live.attachment.generation);
						} catch (cause) {
							return RecorderError.RecorderFailed({ cause });
						}
						if (obsolete) {
							const retired =
								held?.recording.id === live.audioBlobId
									? await held.retireCapture()
									: await call<void>('retire_recording', {
											audioBlobId: live.audioBlobId,
											destination,
										});
							return retired.error ? Err(retired.error) : Ok(null);
						}
					}
					return wrap(live);
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
			start({ into, selectedDeviceId = null }) {
				return run(async () => {
					const engine = attachmentEngineOf(into);
					if (
						JSON.stringify(engine.destination) !== JSON.stringify(destination)
					)
						return RecorderError.RecorderFailed({
							cause: new Error('The attachment belongs to another library.'),
						});
					const prepared = await engine.prepare();
					if (prepared.error)
						return RecorderError.RecorderFailed({ cause: prepared.error });
					const permitted = await permission('request_microphone_permission');
					if (permitted.error) return permitted;
					const result = await call<NativeRecording>('start_recording', {
						deviceIdentifier: selectedDeviceId,
						destination,
						attachment: {
							tableName: into.tableName,
							rowId: into.rowId,
							generation: engine.generation(),
						},
					});
					if (result.error) return Err(result.error);
					return wrap(result.data, into);
				});
			},
		},
	};
}
