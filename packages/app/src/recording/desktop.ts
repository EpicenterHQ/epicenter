import { parseBlobId } from '@epicenter/blobs';
import { isAppId } from '@epicenter/constants/app-id';
import { asDeviceIdentifier } from '@epicenter/recorder';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import {
	type NativeRecording,
	RecorderError,
	type RecorderStopResult,
	type Recording,
	type RecordingEndedReason,
	type RecordingOptions,
	type RecordingOwner,
} from '../recorder.js';

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
		case 'CaptureLost':
			return RecorderError.CaptureLost({ cause });
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

/** The App owns capture; Stop commits bytes to its app-local store. */
export function createDesktopRecording(
	appId: string,
	{ assertUsable }: RecordingOptions,
): RecordingOwner {
	if (!isAppId(appId)) throw new Error(`Invalid recording app ID '${appId}'.`);
	const sessionId = crypto.randomUUID();
	let registered = false;
	let registrationAttempted = false;
	let closed = false;
	let closing: Promise<void> | undefined;
	let pendingRequest:
		| {
				requestId: string;
				deviceIdentifier: string | null;
				resolved?: Recording | null;
		  }
		| undefined;
	let starting = false;
	let held: Recording | null = null;
	let reconcileHeld:
		| ((reason: RecordingEndedReason | null) => void)
		| undefined;
	let releaseHeld: (() => void) | undefined;
	let uncertainCancel = false;
	const operations = new Set<Promise<unknown>>();
	const listeners = new Set<Promise<UnlistenFn>>();
	const cleanupErrors: unknown[] = [];
	function assertOpen() {
		if (closed) throw new Error('Recording is closed.');
		assertUsable?.();
	}
	function run<T>(operation: () => Promise<T>) {
		assertOpen();
		const pending = Promise.resolve().then(operation);
		operations.add(pending);
		void pending.then(
			() => operations.delete(pending),
			() => operations.delete(pending),
		);
		return pending;
	}
	function subscribe<T>(
		event: string,
		handler: (payload: T) => void,
		ready?: () => Promise<void>,
	) {
		let active = true;
		const pending = listen<T>(event, ({ payload }) => {
			if (!closed && active) handler(payload);
		});
		listeners.add(pending);
		void pending.catch((cause) => cleanupErrors.push(cause));
		if (ready) {
			const reconciliation = pending.then(ready);
			operations.add(reconciliation);
			void reconciliation.then(
				() => operations.delete(reconciliation),
				(cause) => {
					operations.delete(reconciliation);
					cleanupErrors.push(cause);
				},
			);
		}
		return () => {
			active = false;
			if (listeners.delete(pending)) {
				const release = pending.then((stop) => stop());
				operations.add(release);
				void release.then(
					() => operations.delete(release),
					(cause) => {
						operations.delete(release);
						cleanupErrors.push(cause);
					},
				);
			}
		};
	}
	function wrap(live: NativeRecording): Recording {
		let endedReason = live.endedReason;
		reconcileHeld = (reason) => {
			endedReason ??= reason;
		};
		uncertainCancel = false;
		let resolving = false;
		let finished: RecorderStopResult | undefined;
		const subscriptions = new Set<() => void>();
		function release() {
			for (const stop of subscriptions) stop();
			subscriptions.clear();
		}
		releaseHeld = release;
		const recording: Recording = Object.freeze({
			id: live.audioBlobId,
			device: {
				...live.device,
				deviceId: asDeviceIdentifier(live.device.deviceId),
			},
			get endedReason() {
				return endedReason;
			},
			stop() {
				return run(async () => {
					if (finished) return Ok(finished);
					if (resolving || held !== recording)
						return RecorderError.NoActiveRecording();
					resolving = true;
					try {
						const result = await call<RecorderStopResult>('stop_recording', {
							sessionId,
							audioBlobId: recording.id,
						});
						if (result.error) {
							if (
								result.error.name === 'CaptureLost' ||
								result.error.name === 'NoActiveRecording'
							) {
								held = null;
								release();
							}
							return result;
						}
						if (
							!parseBlobId(result.data.blobId) ||
							!result.data.blobId.endsWith('.wav') ||
							result.data.blobId !== recording.id
						)
							return RecorderError.RecorderFailed({
								cause: 'The host returned an invalid saved blob.',
							});
						finished = result.data;
						held = null;
						release();
						return Ok(finished);
					} finally {
						resolving = false;
					}
				});
			},
			cancel() {
				return run(async () => {
					if (resolving || held !== recording)
						return RecorderError.NoActiveRecording();
					resolving = true;
					try {
						const result = await call<void>('cancel_recording', {
							sessionId,
							audioBlobId: recording.id,
						});
						uncertainCancel =
							result.error !== null &&
							result.error.name !== 'NoActiveRecording';
						if (!result.error || result.error.name === 'NoActiveRecording') {
							held = null;
							release();
						}
						return result;
					} finally {
						resolving = false;
					}
				});
			},
			onLevel(handler) {
				assertOpen();
				if (held !== recording) return () => {};
				const stop = subscribe<{ audioBlobId: string; level: number }>(
					'mic-level',
					(event) => {
						if (held === recording && event.audioBlobId === recording.id)
							handler(event.level);
					},
				);
				subscriptions.add(stop);
				return () => {
					subscriptions.delete(stop);
					stop();
				};
			},
			onEnded(handler) {
				assertOpen();
				if (held !== recording) return () => {};
				let active = true;
				let announced = false;
				function announce(reason: RecordingEndedReason) {
					if (closed || !active || announced || held !== recording) return;
					announced = true;
					endedReason = reason;
					handler(reason);
				}
				const stop = subscribe<{
					audioBlobId: string;
					reason: RecordingEndedReason;
				}>(
					'recording-ended-event',
					(event) => {
						if (event.audioBlobId === recording.id) announce(event.reason);
					},
					async () => {
						if (closed || !active || held !== recording) return;
						const result = await call<NativeRecording | null>(
							'current_recording',
							{ sessionId },
						);
						if (
							result.data?.audioBlobId === recording.id &&
							result.data.endedReason
						)
							announce(result.data.endedReason);
					},
				);
				subscriptions.add(stop);
				if (endedReason) {
					const reason = endedReason;
					queueMicrotask(() => announce(reason));
				}
				return () => {
					active = false;
					subscriptions.delete(stop);
					stop();
				};
			},
		});
		return recording;
	}
	return {
		close() {
			if (closing) return closing;
			closed = true;
			closing = (async () => {
				while (operations.size) await Promise.allSettled(operations);
				if (registrationAttempted) {
					const result = await call<void>('close_recording_session', {
						sessionId,
					});
					if (result.error) cleanupErrors.push(result.error);
				}
				for (const pending of listeners) {
					try {
						await (await pending)();
					} catch (cause) {
						cleanupErrors.push(cause);
					}
				}
				listeners.clear();
				held = null;
				if (cleanupErrors.length)
					throw new AggregateError(cleanupErrors, 'Recording cleanup failed.');
			})();
			return closing;
		},
		value: {
			current() {
				return run(async () => {
					if (!registered) return Ok(null);
					const request = pendingRequest;
					const observed = held;
					const result = await call<NativeRecording | null>(
						request ? 'resolve_recording_start' : 'current_recording',
						request
							? { sessionId, requestId: request.requestId }
							: { sessionId },
					);
					if (pendingRequest !== request || held !== observed) return Ok(held);
					if (result.error)
						return request
							? RecorderError.StartUnconfirmed({ cause: result.error })
							: result;
					if (request) {
						if (result.data) held = wrap(result.data);
						request.resolved = held;
						pendingRequest = undefined;
					}
					if (result.data && result.data.audioBlobId === held?.id)
						reconcileHeld?.(result.data.endedReason);
					if (result.data === null && uncertainCancel) {
						held = null;
						releaseHeld?.();
						uncertainCancel = false;
					}
					return Ok(held);
				});
			},
			enumerateDevices() {
				return run(async () => {
					const result = await call<string[]>('enumerate_recording_devices');
					return result.error
						? Err(result.error)
						: Ok(
								result.data.map((name) => ({
									id: asDeviceIdentifier(name),
									label: name,
								})),
							);
				});
			},
			start({ selectedDeviceId = null }) {
				return run(async () => {
					if (starting || held) return RecorderError.AlreadyRecording();
					starting = true;
					try {
						if (!registered) {
							const generation = await call<number>(
								'recording_document_generation',
							);
							if (generation.error) return generation;
							if (closed) return RecorderError.NoActiveRecording();
							registrationAttempted = true;
							const result = await call<void>('register_recording_session', {
								appId,
								generation: generation.data,
								sessionId,
							});
							if (result.error) return result;
							registered = true;
						}
						if (closed) return RecorderError.NoActiveRecording();
						if (!pendingRequest) {
							const permission = await call<string>(
								'request_microphone_permission',
							);
							if (permission.error) return permission;
							if (
								permission.data !== 'granted' &&
								permission.data !== 'unknown'
							)
								return RecorderError.MicrophonePermissionDenied();
							if (closed) return RecorderError.NoActiveRecording();
							pendingRequest = {
								requestId: crypto.randomUUID(),
								deviceIdentifier: selectedDeviceId,
							};
						}
						const request = pendingRequest;
						const resolvedElsewhere = () =>
							request.resolved && held === request.resolved
								? Ok(request.resolved)
								: RecorderError.NoActiveRecording();
						const result = await call<NativeRecording>('start_recording', {
							sessionId,
							requestId: request.requestId,
							deviceIdentifier: request.deviceIdentifier,
						});
						if (pendingRequest !== request) return resolvedElsewhere();
						if (result.error) {
							if (result.error.name !== 'RecorderFailed') {
								pendingRequest = undefined;
								return result;
							}
							const current = await call<NativeRecording | null>(
								'resolve_recording_start',
								{ sessionId, requestId: request.requestId },
							);
							if (pendingRequest !== request) return resolvedElsewhere();
							if (current.error)
								return RecorderError.StartUnconfirmed({
									cause: new AggregateError(
										[result.error, current.error],
										'Native start and its reconciliation failed.',
									),
								});
							pendingRequest = undefined;
							if (!current.data) return result;
							held = wrap(current.data);
							return Ok(held);
						}
						pendingRequest = undefined;
						held = wrap(result.data);
						return Ok(held);
					} finally {
						starting = false;
					}
				});
			},
		},
	};
}
