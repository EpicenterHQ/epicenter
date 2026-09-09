import { generateBlobId } from '@epicenter/blobs';
import {
	browserBlobStoreName,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok } from 'wellcrafted/result';
import {
	enumerateDevices,
	getRecordingStream,
	type DeviceStreamError,
} from './device-stream.js';
import {
	captureRecordingAccount,
	RecorderError,
	type RecordingAccount,
	type Recording,
	type RecordingEndedReason,
	type RecordingService,
} from './recording.js';

const log = createLogger('browser-recording');

function acquisitionError(error: DeviceStreamError) {
	return error.name === 'PermissionDenied'
		? RecorderError.MicrophonePermissionDenied({ cause: error })
		: RecorderError.NoInputDevice({ cause: error });
}

/** Browser capture belongs to this document; construction acquires no resources. */
export function createBrowserRecording(
	appId: string,
	input: RecordingAccount,
): RecordingService {
	browserBlobStoreName({ appId, principalId: 'local' });
	const account = captureRecordingAccount(input);
	let current: Recording | null = null;
	let pending = false;
	return {
		async current() {
			if (pending) return RecorderError.AlreadyRecording();
			return Ok(current);
		},
		async enumerateDevices() {
			const result = await enumerateDevices();
			return result.error ? acquisitionError(result.error) : Ok(result.data);
		},
		async start(params = {}) {
			if (pending || current) return RecorderError.AlreadyRecording();
			pending = true;
			let release = () => {};
			try {
				const store = createBrowserBlobStore(
					account === null
						? { appId, principalId: 'local' }
						: { appId, ...account },
				);
				const acquired = await getRecordingStream({
					selectedDeviceId: params.selectedDeviceId ?? null,
				});
				if (acquired.error) return acquisitionError(acquired.error);
				const { stream, deviceOutcome } = acquired.data;
				release = () => {
					for (const track of stream.getTracks()) track.stop();
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
					if (frame !== undefined) cancelAnimationFrame(frame);
					frame = undefined;
					source?.disconnect();
					source = undefined;
					if (context && context.state !== 'closed')
						void context.close().catch((cause) => {
							log.warn(RecorderError.RecorderFailed({ cause }).error);
						});
					context = undefined;
				}
				function releaseCapture() {
					releaseMeter();
					for (const track of stream.getTracks()) track.stop();
				}
				function markEnded(reason: RecordingEndedReason) {
					if (endedReason || resolving) return;
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
				function cleanup() {
					releaseCapture();
					recorder.removeEventListener('start', onStart);
					recorder.removeEventListener('dataavailable', onData);
					recorder.removeEventListener('error', onError);
					recorder.removeEventListener('stop', onStop);
					for (const track of stream.getTracks())
						track.removeEventListener('ended', onTrackEnded);
					levels.clear();
					ended.clear();
					chunks.length = 0;
				}
				release = () => {
					if (recorder.state !== 'inactive') recorder.stop();
					cleanup();
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
					account,
					device: deviceOutcome,
					get endedReason() {
						return endedReason;
					},
					async stop() {
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
							cleanup();
							if (current === session) current = null;
						}
					},
					async cancel() {
						if (resolving || current !== session)
							return RecorderError.NoActiveRecording();
						resolving = true;
						try {
							await finishCapture();
							return Ok(undefined);
						} catch (cause) {
							return RecorderError.RecorderFailed({ cause });
						} finally {
							cleanup();
							if (current === session) current = null;
						}
					},
					onEnded(handler) {
						if (!resolving) {
							ended.add(handler);
							const reason = endedReason;
							if (reason)
								queueMicrotask(() => {
									if (ended.has(handler)) handler(reason);
								});
						}
						return () => {
							ended.delete(handler);
						};
					},
					onLevel(handler) {
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
									samples.reduce((sum, sample) => sum + sample * sample, 0) /
										samples.length,
								);
								for (const listener of levels) listener(Math.min(1, rms));
								if (context && levels.size) frame = requestAnimationFrame(tick);
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
				return Ok(session);
			} catch (cause) {
				release();
				return RecorderError.RecorderFailed({ cause });
			} finally {
				pending = false;
			}
		},
	};
}
