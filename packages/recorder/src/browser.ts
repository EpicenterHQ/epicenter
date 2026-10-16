/**
 * Recording in a browser tab, with `MediaRecorder`.
 *
 * A page has no native side, so the audio is held in memory while it records
 * and written to the folder as `<path>.<extension>` on stop, through the
 * folder's own `files.create`. A refresh or a closed tab loses the recording
 * in progress; the folder then shows a row without audio. `recoverRecordings`
 * has nothing to repair.
 *
 * A chosen microphone is asked for by its exact ID. When the browser cannot
 * open exactly that one, the answer is a refusal: no other microphone is
 * opened in its place. Every stream opened here has one owner that releases
 * it, and a start withdrawn while the browser is still answering releases the
 * stream when it arrives.
 *
 * The page's microphone streams and voice activity detection are here too:
 * they call `getUserMedia`, so only a browser build reaches them.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	RecorderError,
	type RecordingEndedReason,
	type RecordingInput,
	type RecoverRecordings,
	type StartRecording,
} from './recording.js';

export {
	cleanupRecordingStream,
	DeviceStreamError,
	getRecordingStream,
} from './device-stream.js';
export {
	asDeviceIdentifier,
	type DeviceAcquisitionOutcome,
	type DeviceIdentifier,
} from './devices.js';
export * from './recording.js';
export {
	createVadRecorder,
	type StartActiveListeningOptions,
	type VadRecorder,
	type VadRecorderError,
} from './vad-recorder.js';

/** The level reading a recording needs from an audio graph. */
type LevelContext = {
	createMediaStreamSource(stream: MediaStream): {
		connect(node: unknown): unknown;
		disconnect(): void;
	};
	createAnalyser(): {
		fftSize: number;
		getFloatTimeDomainData(samples: Float32Array<ArrayBuffer>): void;
	};
	resume(): Promise<void>;
	close(): Promise<void>;
};

/** What of the browser a recording uses. Tests supply their own. */
export type BrowserEnvironment = {
	readonly mediaDevices: Pick<MediaDevices, 'getUserMedia'> | undefined;
	readonly Recorder:
		| {
				new (
					stream: MediaStream,
					options?: MediaRecorderOptions,
				): MediaRecorder;
				isTypeSupported(type: string): boolean;
		  }
		| undefined;
	/** Undefined where the browser cannot measure audio: levels are then never heard. */
	readonly createLevelContext: (() => LevelContext) | undefined;
	readonly now: () => number;
};

function browserEnvironment(): BrowserEnvironment {
	return {
		mediaDevices:
			typeof navigator === 'undefined' ||
			navigator.mediaDevices?.getUserMedia === undefined
				? undefined
				: navigator.mediaDevices,
		Recorder: typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder,
		createLevelContext:
			typeof AudioContext === 'undefined'
				? undefined
				: () => new AudioContext(),
		now: () => Date.now(),
	};
}

/** Containers in preference order, with the extension each is saved under. */
const CONTAINERS = [
	{ type: 'audio/webm;codecs=opus', extension: 'webm' },
	{ type: 'audio/webm', extension: 'webm' },
	{ type: 'audio/mp4', extension: 'mp4' },
	{ type: 'audio/ogg;codecs=opus', extension: 'ogg' },
] as const;

/** The extension for what the recorder says it produces; WebM when it says nothing. */
function extensionOf(mimeType: string): string {
	const container = mimeType.split(';')[0]?.trim().toLowerCase();
	if (container === 'audio/mp4' || container === 'video/mp4') return 'mp4';
	if (container === 'audio/ogg') return 'ogg';
	return 'webm';
}

/** How often the level is read while recording. */
const LEVEL_INTERVAL_MS = 50;

const release = (stream: MediaStream) => {
	for (const track of stream.getTracks()) track.stop();
};

/** A browser error's name. `OverconstrainedError` is not a `DOMException` everywhere. */
const nameOf = (cause: unknown) =>
	typeof cause === 'object' && cause !== null && 'name' in cause
		? String(cause.name)
		: '';

/**
 * Open one microphone: exactly `input`, or the system default when none is
 * chosen. The caller owns the stream it is given and must release it.
 */
async function open(
	mediaDevices: NonNullable<BrowserEnvironment['mediaDevices']>,
	input: RecordingInput | undefined,
	signal: AbortSignal | undefined,
): Promise<Result<MediaStream, RecorderError>> {
	if (signal?.aborted) return RecorderError.Cancelled();
	let stream: MediaStream;
	try {
		stream = await mediaDevices.getUserMedia({
			audio:
				input === undefined ? true : { deviceId: { exact: input.deviceId } },
		});
	} catch (cause) {
		if (signal?.aborted) return RecorderError.Cancelled();
		const name = nameOf(cause);
		if (name === 'NotAllowedError' || name === 'SecurityError')
			return RecorderError.PermissionDenied();
		// An exact ID the browser cannot satisfy: the microphone is not there.
		if (
			input !== undefined &&
			(name === 'OverconstrainedError' || name === 'NotFoundError')
		)
			return RecorderError.InputUnavailable({ label: input.label });
		if (name === 'NotFoundError')
			return RecorderError.NoInputDevice({ reason: 'no microphone was found' });
		return RecorderError.Failed({ cause });
	}
	// Withdrawn while the browser was answering: this stream has no other owner.
	if (signal?.aborted) {
		release(stream);
		return RecorderError.Cancelled();
	}
	if (input !== undefined) {
		// A browser that reports which microphone it opened must report this one.
		const opened = stream.getAudioTracks()[0]?.getSettings().deviceId;
		if (opened !== undefined && opened !== '' && opened !== input.deviceId) {
			release(stream);
			return RecorderError.InputUnavailable({ label: input.label });
		}
	}
	return Ok(stream);
}

/**
 * Read the input's level into `listeners` until the returned function is
 * called. Nothing is played: the analyser is the end of the graph.
 */
function meter(
	environment: BrowserEnvironment,
	stream: MediaStream,
	listeners: ReadonlySet<(level: number) => void>,
): () => void {
	if (environment.createLevelContext === undefined) return () => {};
	let context: LevelContext | undefined;
	try {
		context = environment.createLevelContext();
		const source = context.createMediaStreamSource(stream);
		const analyser = context.createAnalyser();
		analyser.fftSize = 1024;
		source.connect(analyser);
		void context.resume().catch(() => {});
		const samples = new Float32Array(analyser.fftSize);
		const timer = setInterval(() => {
			if (listeners.size === 0) return;
			analyser.getFloatTimeDomainData(samples);
			let squares = 0;
			for (const sample of samples) squares += sample * sample;
			const level = Math.min(1, Math.sqrt(squares / samples.length));
			for (const listener of listeners) listener(level);
		}, LEVEL_INTERVAL_MS);
		const graph = context;
		return () => {
			clearInterval(timer);
			source.disconnect();
			void graph.close().catch(() => {});
		};
	} catch {
		// A recording without a meter is still a recording.
		void context?.close().catch(() => {});
		return () => {};
	}
}

/** Recording over `environment`, the browser's own by default. */
export function createBrowserRecorder(
	environment: BrowserEnvironment = browserEnvironment(),
): { startRecording: StartRecording; recoverRecordings: RecoverRecordings } {
	const startRecording: StartRecording = async ({
		folder,
		path,
		input,
		signal,
	}) => {
		const { mediaDevices, Recorder } = environment;
		if (mediaDevices === undefined)
			return RecorderError.Unavailable({
				reason: 'this window has no microphone access',
			});
		if (Recorder === undefined)
			return RecorderError.Unavailable({
				reason: 'this window cannot encode audio',
			});
		const { data: stream, error: openError } = await open(
			mediaDevices,
			input,
			signal,
		);
		if (openError !== null) return Err(openError);
		const container = CONTAINERS.find(({ type }) =>
			Recorder.isTypeSupported(type),
		);
		let recorder: MediaRecorder;
		try {
			recorder = new Recorder(
				stream,
				container === undefined ? undefined : { mimeType: container.type },
			);
		} catch (cause) {
			release(stream);
			return RecorderError.Failed({ cause });
		}
		const chunks: Blob[] = [];
		recorder.addEventListener('dataavailable', (event) => {
			if (event.data.size > 0) chunks.push(event.data);
		});
		const startedAt = environment.now();
		try {
			recorder.start();
		} catch (cause) {
			release(stream);
			return RecorderError.Failed({ cause });
		}
		const levels = new Set<(level: number) => void>();
		const endings = new Set<(reason: RecordingEndedReason) => void>();
		const stopMeter = meter(environment, stream, levels);
		const file = `${path}.${container?.extension ?? extensionOf(recorder.mimeType)}`;
		// The microphone going away ends the capture; what was recorded stays.
		for (const track of stream.getAudioTracks())
			track.addEventListener?.('ended', () => {
				for (const listener of endings) listener('deviceDisconnected');
			});
		let settled = false;
		const end = () => {
			settled = true;
			stopMeter();
			levels.clear();
			endings.clear();
		};

		/** Stop the encoder and collect what it produced. */
		const finish = () =>
			new Promise<Result<Uint8Array, RecorderError>>((resolve) => {
				recorder.addEventListener(
					'error',
					(event) => resolve(RecorderError.Failed({ cause: event })),
					{ once: true },
				);
				recorder.addEventListener(
					'stop',
					async () => {
						const blob = new Blob(chunks);
						resolve(Ok(new Uint8Array(await blob.arrayBuffer())));
					},
					{ once: true },
				);
				try {
					recorder.stop();
				} catch (cause) {
					resolve(RecorderError.Failed({ cause }));
				}
			});

		return Ok({
			path: file,
			startedAt,
			device: stream.getAudioTracks()[0]?.label || input?.label || '',
			onLevel(listener) {
				levels.add(listener);
				return () => levels.delete(listener);
			},
			onEnded(listener) {
				endings.add(listener);
				return () => endings.delete(listener);
			},
			async stop() {
				if (settled)
					return RecorderError.NotRecording({
						reason: 'it was already stopped or cancelled',
					});
				end();
				const durationMs = Math.round(environment.now() - startedAt);
				const { data: bytes, error } = await finish();
				release(stream);
				if (error !== null) return Err(error);
				if (bytes.byteLength === 0) return RecorderError.Empty();
				const { error: writeError } = await folder.files.create(file, bytes);
				if (writeError !== null)
					return RecorderError.Refused({ reason: writeError.message });
				return Ok({ path: file, durationMs });
			},
			async cancel() {
				if (settled)
					return RecorderError.NotRecording({
						reason: 'it was already stopped or cancelled',
					});
				end();
				try {
					recorder.stop();
				} catch {
					// Already inactive; the tracks are released either way.
				}
				release(stream);
				return Ok(undefined);
			},
		});
	};

	return {
		startRecording,
		// A browser recording is written whole on stop, so none is ever cut off.
		recoverRecordings: async () => Ok([]),
	};
}

export const startRecording: StartRecording = (options) =>
	createBrowserRecorder().startRecording(options);

export const recoverRecordings: RecoverRecordings = (options) =>
	createBrowserRecorder().recoverRecordings(options);
