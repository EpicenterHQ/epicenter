/**
 * Recording in a browser tab, with `MediaRecorder`.
 *
 * A page has no native side, so the audio is held in memory while it records
 * and `stop` answers it: its bytes, the extension of the type the browser
 * actually produced, and how long it ran. The app keeps it where it keeps
 * files. A refresh or a closed tab loses the recording in progress.
 *
 * AAC in MP4 is asked for first (`.m4a`), since a recording lands in folders
 * that native players open, then Opus in WebM (`.webm`). Never bare
 * `audio/mp4`, whose codec differs by engine. The extension is read from what
 * was produced, not from the request: engines differ in what they honor.
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
	type RecordingHandle,
	type RecordingStart,
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

/** The browser's own microphone, encoder, audio graph and clock. */
export function browserEnvironment(): BrowserEnvironment {
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

/** What a browser recording asks `MediaRecorder` for, in order (decision 56). */
export const RECORDING_TYPES = [
	'audio/mp4;codecs=mp4a.40.2',
	'audio/webm;codecs=opus',
] as const;

/** The container of a produced type, by the extension its file is named with. */
const EXTENSIONS: Record<string, { extension: string; mimeType: string }> = {
	'audio/mp4': { extension: 'm4a', mimeType: 'audio/mp4' },
	'video/mp4': { extension: 'm4a', mimeType: 'audio/mp4' },
	'audio/webm': { extension: 'webm', mimeType: 'audio/webm' },
	'video/webm': { extension: 'webm', mimeType: 'audio/webm' },
	'audio/ogg': { extension: 'ogg', mimeType: 'audio/ogg' },
};

/**
 * The file extension and plain MIME type of what a recorder produced, read
 * from its type (`audio/mp4; codecs=mp4a.40.2` is `m4a`). WebM when the
 * browser names no type, as a recorder left to its default records WebM.
 */
export function containerOf(type: string): {
	extension: string;
	mimeType: string;
} {
	const base = type.split(';')[0]?.trim().toLowerCase() ?? '';
	return EXTENSIONS[base] ?? EXTENSIONS['audio/webm']!;
}

/** A finished browser recording: its audio, and how long it ran. */
export type RecordedAudio = {
	readonly bytes: Uint8Array;
	/** `m4a` or `webm` (or `ogg`), from the type the browser produced. */
	readonly extension: string;
	/** The produced container's MIME type, without codecs. */
	readonly mimeType: string;
	readonly durationMs: number;
};

/** A recording in a browser tab: `stop` answers its audio. */
export type BrowserRecording = RecordingHandle<RecordedAudio>;

export type StartBrowserRecording = (
	options?: RecordingStart,
) => Promise<Result<BrowserRecording, RecorderError>>;

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
	const startRecording: StartBrowserRecording = async ({
		input,
		signal,
	} = {}) => {
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
		const requested = RECORDING_TYPES.find((type) =>
			Recorder.isTypeSupported(type),
		);
		let recorder: MediaRecorder;
		try {
			recorder = new Recorder(
				stream,
				requested === undefined ? undefined : { mimeType: requested },
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
		async function finish(): Promise<
			Result<{ bytes: Uint8Array; type: string }, RecorderError>
		> {
			try {
				if (recorder.state !== 'inactive') recorder.stop();
			} catch (cause) {
				return RecorderError.Failed({ cause });
			}
			const { error } = await finished;
			if (error !== null) return Err(error);
			// The produced type, not the requested one: read it from the data.
			const type = chunks[0]?.type || recorder.mimeType || requested || '';
			return Ok({
				bytes: new Uint8Array(await new Blob(chunks).arrayBuffer()),
				type,
			});
		}

		return Ok({
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
						reason: 'it was already stopped',
					});
				end();
				const durationMs = Math.round(
					(ended?.at ?? environment.now()) - startedAt,
				);
				const { data: produced, error } = await finish();
				release(stream);
				if (error !== null) return Err(error);
				if (produced.bytes.byteLength === 0) return RecorderError.Empty();
				return Ok({
					bytes: produced.bytes,
					...containerOf(produced.type),
					durationMs,
				});
			},
		});
	};

	return { startRecording };
}

/** Record from `input` (or the system default) in this tab. */
export const startRecording: StartBrowserRecording = (options) =>
	createBrowserRecorder().startRecording(options);
