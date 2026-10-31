/**
 * Recording in a browser tab, with `MediaRecorder` (decision 84).
 *
 * `startRecording` writes the recording into the app's store as it records:
 * `MediaRecorder` hands over a piece about once a second, and each is
 * appended to `<path>.<ext>` in this browser's private files the moment it
 * arrives (`deviceFiles` from `@epicenter/folder/browser`). A refresh, a
 * crash, or a closed tab keeps every piece already written, and
 * `recoverRecordings` cuts a file a closed tab left half-written back to its
 * last whole piece. While a recording runs this tab holds a Web Lock named
 * for its file, so recovery in another tab leaves it alone.
 *
 * `startPageRecording` holds the audio in the page instead and `stop`
 * answers it, for a page whose store is not in this browser (an online
 * variant writes it to the repository when it stops).
 *
 * AAC in MP4 is asked for first (`.m4a`), since a recording lands in folders
 * that native players open, then Opus in WebM (`.webm`). Never bare
 * `audio/mp4`, whose codec differs by engine. The extension is read from what
 * the recorder reports, not from the request: engines differ in what they
 * honor. Both engines hand each piece of MP4 over as a whole fragment.
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
import type { Client, Contract } from '@epicenter/definition/contract';
import { type DeviceFiles, deviceFiles } from '@epicenter/folder/browser';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { repairAudio } from './container.js';
import { openMicrophone, release } from './microphone.js';
import {
	RecorderError,
	type RecordingEndedReason,
	type RecordingHandle,
	type RecordingStart,
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
	/** The files of the store a recording is written into, by path. */
	readonly filesOf: (device: Client<Contract>) => DeviceFiles;
	/**
	 * Web Locks, which keep recovery off a recording another tab is still
	 * writing. Undefined where the browser has none: recovery then trusts
	 * that no other tab records.
	 */
	readonly locks: Pick<LockManager, 'request'> | undefined;
};

/** The browser's own microphone, encoder, audio graph, clock, files, and locks. */
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
		filesOf: deviceFiles,
		locks:
			typeof navigator === 'undefined' || navigator.locks === undefined
				? undefined
				: navigator.locks,
	};
}

/**
 * A generated 440 Hz tone in place of the microphone, for browsers under
 * test that have no fake capture device (WebKit under Playwright). It needs
 * no permission; stopping the recording's tracks stops the tone.
 */
export function toneMicrophone(): Pick<MediaDevices, 'getUserMedia'> {
	return {
		async getUserMedia() {
			const context = new AudioContext();
			const oscillator = context.createOscillator();
			oscillator.frequency.value = 440;
			const destination = context.createMediaStreamDestination();
			oscillator.connect(destination);
			oscillator.start();
			const { stream } = destination;
			for (const track of stream.getTracks())
				track.addEventListener('ended', () => void context.close());
			return stream;
		},
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

/** A recording held in the page, finished: its audio, and how long it ran. */
export type RecordedAudio = {
	readonly bytes: Uint8Array;
	/** `m4a` or `webm` (or `ogg`), from the type the browser produced. */
	readonly extension: string;
	/** The produced container's MIME type, without codecs. */
	readonly mimeType: string;
	readonly durationMs: number;
};

/** A recording held in the page: `stop` answers its audio. */
export type PageRecording = RecordingHandle<RecordedAudio>;

export type StartPageRecording = (
	options?: RecordingStart,
) => Promise<Result<PageRecording, RecorderError>>;

/** How often the level is read while recording. */
const LEVEL_INTERVAL_MS = 50;
/** How much audio each piece `MediaRecorder` hands over holds: what a cut can lose. */
const PIECE_MS = 1000;
/** The Web Lock a tab holds while it writes the recording at `path`. */
const lockOf = (path: string) => `epicenter-recording:${path}`;

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

/**
 * Hold the Web Lock `name` until the returned function is called, or null
 * when another tab holds it. Without Web Locks there is nothing to hold.
 */
async function hold(
	locks: BrowserEnvironment['locks'],
	name: string,
): Promise<(() => void) | null> {
	if (locks === undefined) return () => {};
	let release!: () => void;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const granted = await new Promise<boolean>((answer) => {
		locks
			.request(name, { ifAvailable: true }, async (lock) => {
				answer(lock !== null);
				if (lock !== null) await held;
			})
			.catch(() => answer(false));
	});
	return granted ? release : null;
}

/** The first of `RECORDING_TYPES` the browser records, or undefined for its default. */
const requestedType = (Recorder: NonNullable<BrowserEnvironment['Recorder']>) =>
	RECORDING_TYPES.find((type) => Recorder.isTypeSupported(type));

/**
 * Open the microphone and start `MediaRecorder` over it, handing each piece
 * it produces to `onPiece`, in order. The capture owns the stream: `finish`
 * stops the recorder, waits for its last piece, and releases it.
 */
async function openCapture(
	environment: BrowserEnvironment,
	{ input, signal }: RecordingStart,
	onPiece: (piece: Blob) => void,
) {
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
	const requested = requestedType(Recorder);
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
	recorder.addEventListener('dataavailable', (event) => {
		if (event.data.size > 0) onPiece(event.data);
	});
	const startedAt = environment.now();
	try {
		recorder.start(PIECE_MS);
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

	// Listen from the start: the browser may stop itself before the app calls stop.
	const finished = new Promise<Result<undefined, RecorderError>>((resolve) => {
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
	});

	return Ok({
		startedAt,
		microphone: stream.getAudioTracks()[0]?.label || input?.label || '',
		/** The type the recorder reports producing, or what was asked for. */
		type: recorder.mimeType || requested || '',
		/** Whether `finish` was called. */
		isSettled: () => settled,
		interrupted,
		/** Stop the recorder early, as when storage failed: `finish` still settles it. */
		halt() {
			try {
				if (recorder.state !== 'inactive') recorder.stop();
			} catch {
				// Already stopping.
			}
		},
		onLevel(listener: (level: number) => void) {
			levels.add(listener);
			return () => levels.delete(listener);
		},
		onEnded(listener: (reason: RecordingEndedReason) => void) {
			if (settled) return () => {};
			if (ended !== undefined) {
				listener(ended.reason);
				return () => {};
			}
			endings.add(listener);
			return () => endings.delete(listener);
		},
		/**
		 * Stop the recorder, wait for its last piece, release the microphone,
		 * and answer how long it recorded (to its ending, if it ended first).
		 */
		async finish(): Promise<Result<{ durationMs: number }, RecorderError>> {
			settled = true;
			stopMeter();
			levels.clear();
			endings.clear();
			const durationMs = Math.round(
				(ended?.at ?? environment.now()) - startedAt,
			);
			try {
				if (recorder.state !== 'inactive') recorder.stop();
			} catch (cause) {
				release(stream);
				return RecorderError.Failed({ cause });
			}
			const outcome = await finished;
			release(stream);
			if (outcome.error !== null) return outcome;
			return Ok({ durationMs });
		},
	});
}

type Capture = NonNullable<Awaited<ReturnType<typeof openCapture>>['data']>;

/** Recording over `environment`, the browser's own by default. */
export function createBrowserRecorder(
	environment: BrowserEnvironment = browserEnvironment(),
) {
	/**
	 * Record into `device` at `<path>.<ext>`, appending each piece as it
	 * arrives. Refused before any microphone opens when the store keeps no
	 * files here (a private window) or a file is already at the path.
	 */
	const startRecording: StartRecording = async ({
		device,
		path,
		input,
		signal,
	}) => {
		const files = environment.filesOf(device);
		const { Recorder } = environment;
		const expected = `${path}.${
			containerOf((Recorder && requestedType(Recorder)) ?? '').extension
		}`;
		const there = await files.read(expected);
		if (there.error !== null)
			return RecorderError.Refused({ reason: there.error.message });
		if (there.data !== null)
			return RecorderError.Refused({
				reason: `a file is already at ${expected}`,
			});
		const releaseLock = await hold(environment.locks, lockOf(expected));
		if (releaseLock === null)
			return RecorderError.Busy({
				reason: `another tab is recording into ${expected}`,
			});

		let file = expected;
		let capture: Capture | undefined;
		let created = false;
		let storageFailure: string | undefined;
		let writing = Promise.resolve();
		/** Pieces that arrive before the file's name is settled wait for it. */
		const early: Blob[] = [];
		const write = (piece: Blob) => {
			writing = writing.then(async () => {
				if (storageFailure !== undefined) return;
				const bytes = new Uint8Array(await piece.arrayBuffer());
				const { data, error } = await files.append(file, bytes, {
					create: !created,
					announce: false,
				});
				if (error === null && data === 'landed') {
					created = true;
					return;
				}
				storageFailure =
					error?.message ??
					(created
						? `${file} was removed while it recorded`
						: `a file is already at ${file}`);
				capture?.interrupted('storageFailed');
				capture?.halt();
			});
		};
		const opened = await openCapture(environment, { input, signal }, (piece) =>
			capture === undefined ? early.push(piece) : write(piece),
		);
		if (opened.error !== null) {
			releaseLock();
			return opened;
		}
		const started = opened.data;
		capture = started;
		file = `${path}.${containerOf(started.type).extension}`;
		for (const piece of early.splice(0)) write(piece);

		return Ok({
			path: file,
			startedAt: started.startedAt,
			microphone: started.microphone,
			onLevel: started.onLevel,
			onEnded: started.onEnded,
			async stop() {
				if (started.isSettled())
					return RecorderError.NotRecording({
						reason: 'it was already stopped',
					});
				const finished = await started.finish();
				await writing;
				releaseLock();
				// Every piece has landed: the store's listeners hear the whole file.
				if (created)
					await files.append(file, new Uint8Array(), {
						create: false,
						announce: true,
					});
				if (finished.error !== null) return finished;
				if (!created)
					return storageFailure === undefined
						? RecorderError.Empty()
						: RecorderError.Refused({ reason: storageFailure });
				return Ok({ path: file, durationMs: finished.data.durationMs });
			},
		});
	};

	/**
	 * Cut each `m4a` and `webm` recording directly under `under` back to its
	 * last whole piece, skipping any a tab is still writing.
	 */
	const recoverRecordings: RecoverRecordings = async ({ device, under }) => {
		const files = environment.filesOf(device);
		const listed = await files.list();
		if (listed.error !== null)
			return RecorderError.Failed({ cause: listed.error });
		const repaired: string[] = [];
		for (const { path } of listed.data) {
			const name = path.slice(under.length + 1);
			if (!path.startsWith(`${under}/`) || name.includes('/')) continue;
			const ext = name.slice(name.lastIndexOf('.') + 1);
			if (ext !== 'm4a' && ext !== 'webm') continue;
			const releaseLock = await hold(environment.locks, lockOf(path));
			// A tab is writing it now.
			if (releaseLock === null) continue;
			try {
				const read = await files.read(path);
				if (read.error !== null)
					return RecorderError.Failed({ cause: read.error });
				if (read.data === null) continue;
				const whole = repairAudio(read.data.bytes, ext);
				if (whole === undefined) continue;
				const written = await files.write(path, whole, read.data.version);
				if (written.error !== null)
					return RecorderError.Failed({ cause: written.error });
				if (written.data === 'landed') repaired.push(path);
			} finally {
				releaseLock();
			}
		}
		return Ok(repaired);
	};

	/** Record in the page; `stop` answers the audio, and nothing is written. */
	const startPageRecording: StartPageRecording = async (options = {}) => {
		const pieces: Blob[] = [];
		const opened = await openCapture(environment, options, (piece) =>
			pieces.push(piece),
		);
		if (opened.error !== null) return opened;
		const capture = opened.data;
		return Ok({
			startedAt: capture.startedAt,
			microphone: capture.microphone,
			onLevel: capture.onLevel,
			onEnded: capture.onEnded,
			async stop() {
				if (capture.isSettled())
					return RecorderError.NotRecording({
						reason: 'it was already stopped',
					});
				const finished = await capture.finish();
				if (finished.error !== null) return finished;
				// The produced type, not the requested one: read it from the data.
				const type = pieces[0]?.type || capture.type;
				const bytes = new Uint8Array(await new Blob(pieces).arrayBuffer());
				if (bytes.byteLength === 0) return RecorderError.Empty();
				return Ok({
					bytes,
					...containerOf(type),
					durationMs: finished.data.durationMs,
				});
			},
		});
	};

	return { startRecording, recoverRecordings, startPageRecording };
}

/**
 * Record from `input` (or the system default) into `device` at
 * `<path>.m4a` (or `.webm`), each piece appended as it arrives.
 */
export const startRecording: StartRecording = (options) =>
	createBrowserRecorder().startRecording(options);

/** Repair the recordings under `under` in `device` that a closed tab cut off. */
export const recoverRecordings: RecoverRecordings = (options) =>
	createBrowserRecorder().recoverRecordings(options);

/** Record from `input` (or the system default) in this tab; `stop` answers the audio. */
export const startPageRecording: StartPageRecording = (options) =>
	createBrowserRecorder().startPageRecording(options);
