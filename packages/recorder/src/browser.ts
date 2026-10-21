/**
 * Recording in a browser tab, with `MediaRecorder`.
 *
 * A page has no native side, so the audio is held in memory while it records
 * and written to the folder as `<path>.<extension>` on stop, through the
 * folder's own write, from no file. A refresh or a closed tab loses the recording
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
import { openMicrophone, release } from './microphone.js';
import {
	RecorderError,
	type RecordingEndedReason,
	type RecoverRecordings,
	type StartRecording,
} from './recording.js';

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
) {
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
		const { data: stream, error: openError } = await openMicrophone(
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
		let settled = false;
		let ended: { reason: RecordingEndedReason; at: number } | undefined;
		function interrupted(reason: RecordingEndedReason) {
			if (settled || ended !== undefined) return;
			ended = { reason, at: environment.now() };
			for (const listener of [...endings]) listener(reason);
		}
		// Keep the first ending even when no consumer has subscribed yet.
		for (const track of stream.getAudioTracks())
			track.addEventListener('ended', () => interrupted('deviceDisconnected'));
		const end = () => {
			settled = true;
			stopMeter();
			levels.clear();
			endings.clear();
		};

		// Listen from the start: the browser may stop itself before the app calls stop.
		const finished = new Promise<Result<undefined, RecorderError>>(
			(resolve) => {
				recorder.addEventListener(
					'error',
					(event) => {
						resolve(RecorderError.Failed({ cause: event }));
						interrupted('streamFailed');
					},
					{ once: true },
				);
				recorder.addEventListener(
					'stop',
					() => {
						resolve(Ok(undefined));
						interrupted('streamFailed');
					},
					{ once: true },
				);
			},
		);
		async function finish(): Promise<Result<Uint8Array, RecorderError>> {
			try {
				if (recorder.state !== 'inactive') recorder.stop();
			} catch (cause) {
				return RecorderError.Failed({ cause });
			}
			const { error } = await finished;
			if (error !== null) return Err(error);
			return Ok(new Uint8Array(await new Blob(chunks).arrayBuffer()));
		}

		return Ok({
			path: file,
			startedAt,
			device: stream.getAudioTracks()[0]?.label || input?.label || '',
			onLevel(listener) {
				levels.add(listener);
				return () => levels.delete(listener);
			},
			onEnded(listener) {
				if (settled) return () => {};
				if (ended !== undefined) {
					listener(ended.reason);
					return () => {};
				}
				endings.add(listener);
				return () => endings.delete(listener);
			},
			async stop() {
				if (settled)
					return RecorderError.NotRecording({
						reason: 'it was already stopped or cancelled',
					});
				end();
				const durationMs = Math.round(
					(ended?.at ?? environment.now()) - startedAt,
				);
				const { data: bytes, error } = await finish();
				release(stream);
				if (error !== null) return Err(error);
				if (bytes.byteLength === 0) return RecorderError.Empty();
				const { error: writeError } = await folder.write(file, null, bytes);
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
		recoverRecordings,
	};
}

export const startRecording: StartRecording = (options) =>
	createBrowserRecorder().startRecording(options);

/** A browser recording is written whole on stop, so none is ever cut off. */
export const recoverRecordings: RecoverRecordings = async () => Ok([]);
