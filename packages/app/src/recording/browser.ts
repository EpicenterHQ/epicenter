import { captureLibraryReplica } from '@epicenter/principal';
import { generateBlobId } from '@epicenter/blobs';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok } from 'wellcrafted/result';
import {
	enumerateDevices,
	getRecordingStream,
	type DeviceStreamError,
} from '@epicenter/recorder';
import {
	RecorderError,
	type RecordingReplica,
	type Recording,
	type RecordingEndedReason,
	type RecordingOwner,
	type RecordingOptions,
} from '../recorder.js';

const log = createLogger('browser-recording');

function acquisitionError(error: DeviceStreamError) {
	return error.name === 'PermissionDenied'
		? RecorderError.MicrophonePermissionDenied({ cause: error })
		: RecorderError.NoInputDevice({ cause: error });
}

/** Browser capture belongs to this document; construction acquires no resources. */
export function createBrowserRecording(
	_appId: string,
	input: RecordingReplica,
	{ assertUsable, local: store }: RecordingOptions,
): RecordingOwner {
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

	let current: Recording | null = null;
	let cancelCurrent: (() => Promise<void>) | undefined;
	const releases = new Set<Promise<void>>();
	let pending = false;
	return {
		close() {
			if (closing) return closing;
			closed = true;
			const completion = Promise.withResolvers<void>();
			closing = completion.promise;
			completion.resolve(
				(async () => {
					while (operations.size) await Promise.allSettled(operations);
					if (cancelCurrent) {
						try {
							await cancelCurrent();
						} catch (cause) {
							cleanupErrors.push(cause);
						}
					}
					await Promise.allSettled(releases);
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
					if (pending) return RecorderError.AlreadyRecording();
					return Ok(current);
				});
			},
			enumerateDevices() {
				return run(async () => {
					const result = await enumerateDevices();
					return result.error
						? acquisitionError(result.error)
						: Ok(result.data);
				});
			},
			start(params = {}) {
				return run(async () => {
					if (pending || current) return RecorderError.AlreadyRecording();
					pending = true;
					let release: () => void | Promise<void> = () => {};
					try {
						const acquired = await getRecordingStream({
							selectedDeviceId: params.selectedDeviceId ?? null,
						});
						if (acquired.error) return acquisitionError(acquired.error);
						const { stream, deviceOutcome } = acquired.data;
						release = () => {
							for (const track of stream.getTracks()) {
								try {
									track.stop();
								} catch (cause) {
									cleanupErrors.push(cause);
								}
							}
						};
						const recorder = new MediaRecorder(stream);
						const chunks: Blob[] = [];
						const levels = new Set<(level: number) => void>();
						const ended = new Set<(reason: RecordingEndedReason) => void>();
						let endedReason: RecordingEndedReason | null = null;
						let resolving = false;
						let stopped = false;
						let startedAt = performance.now();
						let durationMs = 0;
						let context: AudioContext | undefined;
						let source: MediaStreamAudioSourceNode | undefined;
						let frame: number | undefined;
						const completion = Promise.withResolvers<void>();
						const startup = Promise.withResolvers<void>();
						function releaseMeter() {
							if (frame !== undefined) {
								try {
									cancelAnimationFrame(frame);
								} catch (cause) {
									cleanupErrors.push(cause);
								}
							}
							frame = undefined;
							try {
								source?.disconnect();
							} catch (cause) {
								cleanupErrors.push(cause);
							}
							source = undefined;
							if (context && context.state !== 'closed') {
								try {
									const closingContext = context.close();
									releases.add(closingContext);
									void closingContext.then(
										() => releases.delete(closingContext),
										(cause) => {
											releases.delete(closingContext);
											cleanupErrors.push(cause);
										},
									);
								} catch (cause) {
									cleanupErrors.push(cause);
								}
							}
							context = undefined;
						}
						function releaseCapture() {
							releaseMeter();
							for (const track of stream.getTracks()) {
								try {
									track.stop();
								} catch (cause) {
									cleanupErrors.push(cause);
								}
							}
						}
						function markEnded(reason: RecordingEndedReason) {
							if (closed || endedReason || resolving) return;
							endedReason = reason;
							for (const handler of ended) {
								try {
									handler(reason);
								} catch (cause) {
									log.warn(RecorderError.RecorderFailed({ cause }).error);
								}
							}
						}
						function onTrackEnded() {
							markEnded('deviceDisconnected');
						}
						function onData(event: BlobEvent) {
							if (event.data.size) chunks.push(event.data);
						}
						function onStart() {
							startedAt = performance.now();
							startup.resolve();
						}
						function onError(event: Event) {
							startup.reject(event);
							markEnded('streamFailed');
							// The recorder queues final data and stop after error. Do not discard it.
							releaseCapture();
						}
						function onStop() {
							startup.reject(
								new Error('Recording stopped before startup completed.'),
							);
							stopped = true;
							durationMs = Math.max(0, performance.now() - startedAt);
							releaseCapture();
							completion.resolve();
							markEnded('streamFailed');
						}
						async function cleanup() {
							try {
								releaseCapture();
							} catch (cause) {
								cleanupErrors.push(cause);
							}
							recorder.removeEventListener('start', onStart);
							recorder.removeEventListener('dataavailable', onData);
							recorder.removeEventListener('error', onError);
							recorder.removeEventListener('stop', onStop);
							for (const track of stream.getTracks())
								track.removeEventListener('ended', onTrackEnded);
							levels.clear();
							ended.clear();
							chunks.length = 0;
							await Promise.allSettled(releases);
						}
						release = async () => {
							try {
								if (recorder.state !== 'inactive') recorder.stop();
							} finally {
								await cleanup();
							}
						};
						recorder.addEventListener('start', onStart);
						recorder.addEventListener('dataavailable', onData);
						recorder.addEventListener('error', onError);
						recorder.addEventListener('stop', onStop);
						for (const track of stream.getTracks())
							track.addEventListener('ended', onTrackEnded);
						recorder.start(1000);
						await startup.promise;
						async function finishCapture() {
							if (!stopped && recorder.state !== 'inactive') recorder.stop();
							await completion.promise;
						}
						const audioBlobId = generateBlobId();
						const session: Recording = {
							audioBlobId,
							replica,
							device: deviceOutcome,
							get endedReason() {
								return endedReason;
							},
							stop() {
								return run(async () => {
									if (resolving || current !== session)
										return RecorderError.NoActiveRecording();
									resolving = true;
									try {
										await finishCapture();
										const blob = new Blob(chunks, {
											type: recorder.mimeType || chunks[0]?.type,
										});
										const result = await store.put(audioBlobId, blob);
										if (result.error) return Err(result.error);
										return Ok({
											audioBlobId,
											durationMs,
											byteLength: blob.size,
										});
									} catch (cause) {
										return RecorderError.RecorderFailed({ cause });
									} finally {
										await cleanup();
										if (current === session) {
											current = null;
											cancelCurrent = undefined;
										}
									}
								});
							},
							cancel() {
								return run(async () => {
									if (resolving || current !== session)
										return RecorderError.NoActiveRecording();
									resolving = true;
									try {
										await finishCapture();
										return Ok(undefined);
									} catch (cause) {
										return RecorderError.RecorderFailed({ cause });
									} finally {
										await cleanup();
										if (current === session) {
											current = null;
											cancelCurrent = undefined;
										}
									}
								});
							},
							onEnded(handler) {
								assertOpen();
								if (!resolving) {
									ended.add(handler);
									const reason = endedReason;
									if (reason)
										queueMicrotask(() => {
											if (!closed && ended.has(handler)) handler(reason);
										});
								}
								return () => {
									ended.delete(handler);
								};
							},
							onLevel(handler) {
								assertOpen();
								if (resolving || stopped || endedReason) return () => {};
								if (!context) {
									context = new AudioContext();
									source = context.createMediaStreamSource(stream);
									const analyser = context.createAnalyser();
									analyser.fftSize = 256;
									source.connect(analyser);
									const samples = new Float32Array(analyser.fftSize);
									const tick = () => {
										analyser.getFloatTimeDomainData(samples);
										const rms = Math.sqrt(
											samples.reduce(
												(sum, sample) => sum + sample * sample,
												0,
											) / samples.length,
										);
										if (!closed)
											for (const listener of levels) listener(Math.min(1, rms));
										if (context && levels.size)
											frame = requestAnimationFrame(tick);
									};
									frame = requestAnimationFrame(tick);
								}
								levels.add(handler);
								return () => {
									levels.delete(handler);
									if (levels.size === 0) releaseMeter();
								};
							},
						};
						Object.freeze(session);
						current = session;
						cancelCurrent = async () => {
							resolving = true;
							try {
								await finishCapture();
							} finally {
								await cleanup();
							}
							current = null;
							cancelCurrent = undefined;
						};
						return Ok(session);
					} catch (cause) {
						try {
							await release();
						} catch (cleanupError) {
							cleanupErrors.push(cleanupError);
						}
						return RecorderError.RecorderFailed({ cause });
					} finally {
						pending = false;
					}
				});
			},
		},
	};
}
