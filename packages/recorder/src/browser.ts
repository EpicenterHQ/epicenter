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
 * for its path without the extension, so recovery in another tab leaves its
 * file alone whatever extension the browser's type gave it.
 *
 * `startPageRecording` holds the audio in the page instead and `stop`
 * answers it, for a page whose store is not in this browser (an online
 * variant writes it to the repository when it stops).
 *
 * AAC in MP4 is asked for first (`.m4a`), since a recording lands in folders
 * that native players open, then Opus in WebM (`.webm`). Never bare
 * `audio/mp4`, whose codec differs by engine. The extension is read from what
 * the recorder reports, not from the request (`extensionOf`): engines differ
 * in what they honor. Both engines hand each piece of MP4 over as a whole
 * fragment.
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
import { deviceFiles } from '@epicenter/folder/browser';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import { audioDurationMs, repairAudio } from './container.js';
import { openMicrophone, release } from './microphone.js';
import {
	type OpenMeter,
	RecorderError,
	type RecordingEndedReason,
	type RecordingHandle,
	type RecordingStart,
	type RecoveredRecording,
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

/** What a browser recording asks `MediaRecorder` for, in order (decision 56). */
const RECORDING_TYPES = [
	'audio/mp4;codecs=mp4a.40.2',
	'audio/webm;codecs=opus',
] as const;

/**
 * The extension a recording's file is named with, from the type a recorder
 * produced however the engine spells it (`audio/mp4; codecs=mp4a.40.2` is
 * `m4a`). WebM when the browser names no type or one not listed here, as a
 * recorder left to its default records WebM.
 */
function extensionOf(type: string): 'm4a' | 'webm' | 'ogg' {
	const container = type.split(';')[0]?.trim().toLowerCase();
	if (container === 'audio/mp4' || container === 'video/mp4') return 'm4a';
	if (container === 'audio/ogg') return 'ogg';
	return 'webm';
}

/** A recording held in the page, finished: its audio, and how long it plays. */
export type RecordedAudio = {
	readonly bytes: Uint8Array;
	/** `m4a` or `webm` (or `ogg`), from the type the browser produced. */
	readonly extension: string;
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
/**
 * The Web Lock a tab holds while it writes the recording at `path`, the
 * path a start is given, without an extension: the file's extension is the
 * type the recorder produced, known only once it runs.
 */
const lockOf = (path: string) => `epicenter-recording:${path}`;

/**
 * Read the input's level into `listeners` until the returned function is
 * called. Nothing is played: the analyser is the end of the graph.
 */
function meter(
	stream: MediaStream,
	listeners: ReadonlySet<(level: number) => void>,
): Result<() => void, RecorderError> {
	if (typeof AudioContext === 'undefined')
		return RecorderError.Unavailable({
			reason: 'this window cannot measure audio',
		});
	let context: AudioContext | undefined;
	try {
		context = new AudioContext();
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
		return Ok(() => {
			clearInterval(timer);
			source.disconnect();
			void graph.close().catch(() => {});
		});
	} catch (cause) {
		void context?.close().catch(() => {});
		return RecorderError.Failed({ cause });
	}
}

/**
 * Hold the Web Lock `name` until the returned function is called, or null
 * when another tab holds it. Web Locks keep recovery off a recording another
 * tab is still writing; without them there is nothing to hold, and recovery
 * trusts that no other tab records.
 */
async function hold(name: string): Promise<(() => void) | null> {
	const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
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
const requestedType = () =>
	RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type));

/**
 * Open the microphone and start `MediaRecorder` over it, handing each piece
 * it produces to `onPiece`, in order. The capture owns the stream: `finish`
 * stops the recorder, waits for its last piece, and releases it.
 */
async function openCapture(
	{ input, signal }: RecordingStart,
	onPiece: (piece: Blob) => void,
) {
	if (typeof MediaRecorder === 'undefined')
		return RecorderError.Unavailable({
			reason: 'this window cannot encode audio',
		});
	const { data: stream, error: openError } = await openMicrophone(
		input,
		signal,
	);
	if (openError !== null) return Err(openError);
	const requested = requestedType();
	const { data: recorder, error: createError } = trySync({
		try: () =>
			new MediaRecorder(
				stream,
				requested === undefined ? undefined : { mimeType: requested },
			),
		catch: (cause) => RecorderError.Failed({ cause }),
	});
	if (createError !== null) {
		release(stream);
		return Err(createError);
	}
	recorder.addEventListener('dataavailable', (event) => {
		if (event.data.size > 0) onPiece(event.data);
	});
	const startedAt = Date.now();
	const { error: startError } = trySync({
		try: () => recorder.start(PIECE_MS),
		catch: (cause) => RecorderError.Failed({ cause }),
	});
	if (startError !== null) {
		release(stream);
		return Err(startError);
	}
	/** Stop the recorder, unless it already stopped. */
	const stopRecorder = () =>
		trySync({
			try: () => {
				if (recorder.state !== 'inactive') recorder.stop();
			},
			catch: (cause) => RecorderError.Failed({ cause }),
		});
	const levels = new Set<(level: number) => void>();
	const endings = new Set<(reason: RecordingEndedReason) => void>();
	// A recording without a meter is still a recording.
	const stopMeter = meter(stream, levels).data ?? (() => {});
	let settled = false;
	let ended: { reason: RecordingEndedReason; at: number } | undefined;
	function interrupted(reason: RecordingEndedReason) {
		if (settled || ended !== undefined) return;
		ended = { reason, at: Date.now() };
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
			// One that cannot stop is stopping already: `finish` settles it.
			stopRecorder();
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
			const durationMs = Math.round((ended?.at ?? Date.now()) - startedAt);
			// A recorder that cannot stop never says it stopped: do not wait for it.
			const stopped = stopRecorder();
			const outcome = stopped.error !== null ? stopped : await finished;
			release(stream);
			if (outcome.error !== null) return Err(outcome.error);
			return Ok({ durationMs });
		},
	});
}

type Capture = NonNullable<Awaited<ReturnType<typeof openCapture>>['data']>;

/**
 * Record from `input` (or the system default) into `device` at
 * `<path>.m4a` (or `.webm`), appending each piece as it arrives. Refused
 * before any microphone opens when the store keeps no files here (a private
 * window) or a file is already at the path.
 */
export const startRecording: StartRecording = async ({
	device,
	path,
	input,
	signal,
}) => {
	const files = deviceFiles(device);
	const expected = `${path}.${extensionOf(
		(typeof MediaRecorder !== 'undefined' && requestedType()) || '',
	)}`;
	const there = await files.read(expected);
	if (there.error !== null)
		return RecorderError.Refused({ reason: there.error.message });
	if (there.data !== null)
		return RecorderError.Refused({
			reason: `a file is already at ${expected}`,
		});
	const releaseLock = await hold(lockOf(path));
	if (releaseLock === null)
		return RecorderError.Busy({
			reason: `another tab is recording into ${path}`,
		});

	/**
	 * How long the audio written at `path` plays, read from its bytes, or
	 * undefined when they do not read. Not the time between Start and Stop:
	 * an engine drops the first moments of a recording (Safari about 0.3 s).
	 */
	const heldMs = async (path: string) => {
		const { data } = await files.read(path);
		return data
			? audioDurationMs(data.bytes, path.slice(path.lastIndexOf('.') + 1))
			: undefined;
	};
	let file = expected;
	let capture: Capture | undefined;
	let created = false;
	/** Why pieces stopped landing: the recording ended there. */
	let failure: RecorderError | undefined;
	const fail = (error: RecorderError, reason: RecordingEndedReason) => {
		failure = error;
		capture?.interrupted(reason);
		capture?.halt();
	};
	let writing = Promise.resolve();
	/** Pieces that arrive before the file's name is settled wait for it. */
	const early: Blob[] = [];
	const write = (piece: Blob) => {
		writing = writing.then(async () => {
			if (failure !== undefined) return;
			const { data: buffer, error: readError } = await tryAsync({
				try: () => piece.arrayBuffer(),
				catch: (cause) => RecorderError.Failed({ cause }),
			});
			if (readError !== null) return fail(readError, 'streamFailed');
			const { data, error } = await files.append(file, new Uint8Array(buffer), {
				create: !created,
				announce: false,
			});
			if (error === null && data === 'landed') {
				created = true;
				return;
			}
			const reason =
				error?.message ??
				(created
					? `${file} was removed while it recorded`
					: `a file is already at ${file}`);
			fail(RecorderError.Refused({ reason }).error, 'storageFailed');
		});
	};
	const opened = await openCapture({ input, signal }, (piece) =>
		capture === undefined ? early.push(piece) : write(piece),
	);
	if (opened.error !== null) {
		releaseLock();
		return opened;
	}
	const started = opened.data;
	capture = started;
	file = `${path}.${extensionOf(started.type)}`;
	for (const piece of early.splice(0)) write(piece);

	return Ok({
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
				return failure === undefined ? RecorderError.Empty() : Err(failure);
			return Ok({
				// Written at its path as it recorded.
				path: file,
				durationMs: (await heldMs(file)) ?? finished.data.durationMs,
			});
		},
	});
};

/**
 * Repair the recordings under `under` in `device` that a closed tab cut
 * off: cut each `m4a` and `webm` recording directly under it back to its
 * last whole piece, skipping any a tab is still writing, and answer every
 * one no tab is writing, repaired or already whole, with how long it
 * plays: an app tells a cut-off recording from one still recording in
 * another tab only by this answer.
 */
export const recoverRecordings: RecoverRecordings = async ({
	device,
	under,
}) => {
	const files = deviceFiles(device);
	const listed = await files.list();
	if (listed.error !== null)
		return RecorderError.Failed({ cause: listed.error });
	const recovered: RecoveredRecording[] = [];
	for (const { path } of listed.data) {
		const name = path.slice(under.length + 1);
		if (!path.startsWith(`${under}/`) || name.includes('/')) continue;
		const ext = name.slice(name.lastIndexOf('.') + 1);
		if (ext !== 'm4a' && ext !== 'webm') continue;
		const releaseLock = await hold(lockOf(path.slice(0, -ext.length - 1)));
		// A tab is writing it now.
		if (releaseLock === null) continue;
		try {
			const read = await files.read(path);
			if (read.error !== null)
				return RecorderError.Failed({ cause: read.error });
			if (read.data === null) continue;
			const whole = repairAudio(read.data.bytes, ext);
			// Already whole, or not audio that reads.
			if (whole === undefined) {
				recovered.push({
					path,
					durationMs: audioDurationMs(read.data.bytes, ext) ?? null,
				});
				continue;
			}
			const written = await files.write(path, whole, {
				sha256: read.data.version,
			});
			if (written.error !== null)
				return RecorderError.Failed({ cause: written.error });
			if (written.data === 'landed')
				recovered.push({
					path,
					durationMs: audioDurationMs(whole, ext) ?? null,
				});
		} finally {
			releaseLock();
		}
	}
	return Ok(recovered);
};

/**
 * Record from `input` (or the system default) in this tab; `stop` answers
 * the audio, and nothing is written.
 */
export const startPageRecording: StartPageRecording = async (options = {}) => {
	const pieces: Blob[] = [];
	const opened = await openCapture(options, (piece) => pieces.push(piece));
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
			const { data: buffer, error: readError } = await tryAsync({
				try: () => new Blob(pieces).arrayBuffer(),
				catch: (cause) => RecorderError.Failed({ cause }),
			});
			if (readError !== null) return Err(readError);
			const bytes = new Uint8Array(buffer);
			if (bytes.byteLength === 0) return RecorderError.Empty();
			const extension = extensionOf(type);
			return Ok({
				bytes,
				extension,
				durationMs:
					audioDurationMs(bytes, extension) ?? finished.data.durationMs,
			});
		},
	});
};

/**
 * Open `input`, or the system default, for its level until `close`:
 * nothing is recorded or written. A chosen input that is not connected is
 * refused, never replaced, and one that is unplugged ends the meter
 * (`deviceDisconnected`).
 */
export const openMeter: OpenMeter = async ({ input, signal } = {}) => {
	if (typeof AudioContext === 'undefined')
		return RecorderError.Unavailable({
			reason: 'this window cannot measure audio',
		});
	const { data: stream, error: openError } = await openMicrophone(
		input,
		signal,
	);
	if (openError !== null) return Err(openError);
	const levels = new Set<(level: number) => void>();
	const { data: stopMeter, error: meterError } = meter(stream, levels);
	if (meterError !== null) {
		release(stream);
		return Err(meterError);
	}
	const endings = new Set<(reason: RecordingEndedReason) => void>();
	let ended: RecordingEndedReason | undefined;
	let closed = false;
	const track = stream.getAudioTracks()[0];
	// The track ends when its microphone is unplugged or access is withdrawn.
	const onTrackEnded = () => {
		if (closed || ended !== undefined) return;
		ended = 'deviceDisconnected';
		for (const listener of [...endings]) listener(ended);
	};
	track?.addEventListener('ended', onTrackEnded);
	return Ok({
		microphone: track?.label || input?.label || '',
		onLevel(listener) {
			if (closed) return () => {};
			levels.add(listener);
			return () => levels.delete(listener);
		},
		onEnded(listener) {
			if (closed) return () => {};
			if (ended !== undefined) {
				listener(ended);
				return () => {};
			}
			endings.add(listener);
			return () => endings.delete(listener);
		},
		async close() {
			if (closed) return;
			closed = true;
			levels.clear();
			endings.clear();
			stopMeter();
			release(stream);
		},
	});
};

/**
 * Ask for microphone access, so the browser lists inputs by name: the
 * system default microphone is opened and released at once, and nothing is
 * recorded or measured.
 */
export async function allowMicrophone({
	signal,
}: Pick<RecordingStart, 'signal'> = {}): Promise<
	Result<undefined, RecorderError>
> {
	const { data: stream, error } = await openMicrophone(undefined, signal);
	if (error !== null) return Err(error);
	release(stream);
	return Ok(undefined);
}
