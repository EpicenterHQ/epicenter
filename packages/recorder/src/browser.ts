/**
 * Recording in a browser tab, with `MediaRecorder` (decision 84, ADR-0779).
 *
 * A take lands whole: `MediaRecorder` hands over a piece about once a
 * second, the page keeps each in memory, and Stop writes the take once, at
 * `<path>.<ext>` in the app's files, with the folder's `set`. Its duration is
 * the recorder's own clock: the time it spent recording, pauses left out. A
 * take a crash or a closed tab cuts off is lost; keeping one through that
 * is the desktop app's, whose shell outlives the page (ADR-0780). The app's
 * leave guard asks before a page closes while a take runs.
 *
 * AAC in MP4 is asked for first (`.m4a`), since a recording lands in folders
 * that native players open, then Opus in WebM (`.webm`). Never bare
 * `audio/mp4`, whose codec differs by engine. A browser that records neither
 * cannot record. The extension is read from what the recorder reports, not
 * from the request (`extensionOf`): engines differ in what they honor. Both
 * engines hand each piece of MP4 over as a whole fragment.
 *
 * A chosen microphone is asked for by its exact ID. When the browser cannot
 * open exactly that one, the answer is a refusal: no other microphone is
 * opened in its place. Every stream opened here has one owner that releases
 * it, and a start withdrawn while the browser is still answering releases the
 * stream when it arrives.
 *
 * Listing the inputs is the browser's own `enumerateDevices`, and lists
 * nothing by name until microphone access is allowed (`recorder.allow`).
 *
 * The page's microphone streams and voice activity detection are here too:
 * they call `getUserMedia`, so only a browser build reaches them.
 */
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import { mediaDevices, openMicrophone, release } from './microphone.js';
import {
	type Recorder,
	RecorderError,
	type RecordingEndedReason,
	type RecordingStart,
} from './recording.js';
import { createSignals } from './signals.js';

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
 * produced however the engine spells it (`audio/mp4; codecs=mp4a.40.2` and
 * `video/mp4` are `m4a`); otherwise `webm`, the other type it is asked for.
 */
function extensionOf(type: string): 'm4a' | 'webm' {
	const container = type.split(';')[0]?.trim().toLowerCase();
	return container === 'audio/mp4' || container === 'video/mp4'
		? 'm4a'
		: 'webm';
}

/** How often the level is read while recording. */
const LEVEL_INTERVAL_MS = 50;
/** How much audio each piece `MediaRecorder` hands over holds. */
const PIECE_MS = 1000;

/**
 * Read the input's level into `emit` until the returned function is
 * called. Nothing is played: the analyser is the end of the graph.
 */
function meter(
	stream: MediaStream,
	emit: (level: number) => void,
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
			analyser.getFloatTimeDomainData(samples);
			let squares = 0;
			for (const sample of samples) squares += sample * sample;
			emit(Math.min(1, Math.sqrt(squares / samples.length)));
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

/** The first of `RECORDING_TYPES` this window records, if any. */
const requestedType = () =>
	typeof MediaRecorder === 'undefined'
		? undefined
		: RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type));

/**
 * Open the microphone and start `MediaRecorder` over it, handing each piece
 * it produces to `onPiece`, in order. The capture owns the stream: `finish`
 * stops the recorder, waits for its last piece, and releases it.
 */
async function openCapture(
	{ input, signal }: RecordingStart,
	onPiece: (piece: Blob) => void,
) {
	const requested = requestedType();
	if (requested === undefined)
		return RecorderError.Unavailable({
			reason: 'this window cannot encode audio as MP4 or WebM',
		});
	const { data: stream, error: openError } = await openMicrophone(
		input,
		signal,
	);
	if (openError !== null) return Err(openError);
	const { data: recorder, error: createError } = trySync({
		try: () => new MediaRecorder(stream, { mimeType: requested }),
		catch: (cause) => RecorderError.Failed({ cause }),
	});
	if (createError !== null) {
		release(stream);
		return Err(createError);
	}
	recorder.addEventListener('dataavailable', (event) => {
		if (event.data.size > 0) onPiece(event.data);
	});
	/**
	 * The recording's own clock: how long it spent recording, counted from
	 * when the recorder says it started, with its pauses left out.
	 */
	let recordedMs = 0;
	let runningSince: number | undefined;
	const run = () => {
		runningSince ??= performance.now();
	};
	const rest = () => {
		if (runningSince === undefined) return;
		recordedMs += performance.now() - runningSince;
		runningSince = undefined;
	};
	recorder.addEventListener('start', run);
	recorder.addEventListener('resume', run);
	recorder.addEventListener('pause', rest);
	recorder.addEventListener('stop', rest);
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
	const signals = createSignals();
	let settled = false;
	/** Whether capture ended on its own. */
	let ended = false;
	function interrupted(reason: RecordingEndedReason) {
		if (settled || ended) return;
		ended = true;
		// What was recorded until the ending is the take.
		rest();
		signals.end(reason);
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
		/** The type the recorder reports producing, or what was asked for. */
		type: recorder.mimeType || requested,
		/** Whether `finish` was called. */
		isSettled: () => settled,
		onEnded: signals.onEnded,
		/**
		 * Stop the recorder, wait for its last piece, release the microphone,
		 * and answer how long it recorded by its own clock (to its ending, if
		 * it ended first).
		 */
		async finish(): Promise<Result<{ durationMs: number }, RecorderError>> {
			settled = true;
			signals.retire();
			// A recorder that cannot stop never says it stopped: do not wait for it.
			const stopped = stopRecorder();
			const outcome = stopped.error !== null ? stopped : await finished;
			rest();
			release(stream);
			if (outcome.error !== null) return Err(outcome.error);
			return Ok({ durationMs: Math.round(recordedMs) });
		},
	});
}

/** The recording `path` names in its files, by `{ id, ext }`. */
const recordingAt = (path: string, ext: string) => ({
	id: path.slice(path.lastIndexOf('/') + 1),
	ext,
});

/**
 * Record from `input` (or the system default), keeping each piece in
 * memory, and at Stop write the take once into `files` at `<path>.m4a` (or
 * `.webm`). Refused before any microphone opens when a file is already at
 * the path.
 */
const start: Recorder['start'] = async ({ files, path, input, signal }) => {
	const expected = recordingAt(path, extensionOf(requestedType() ?? ''));
	if (files.get(expected) !== undefined)
		return RecorderError.Refused({
			reason: `a file is already at ${path}.${expected.ext}`,
		});
	const pieces: Blob[] = [];
	const opened = await openCapture({ input, signal }, (piece) =>
		pieces.push(piece),
	);
	if (opened.error !== null) return opened;
	const capture = opened.data;
	const file = recordingAt(path, extensionOf(capture.type));

	return Ok({
		onEnded: capture.onEnded,
		async stop() {
			if (capture.isSettled())
				return RecorderError.NotRecording({
					reason: 'it was already stopped',
				});
			const finished = await capture.finish();
			if (finished.error !== null) return finished;
			if (pieces.length === 0) return RecorderError.Empty();
			const { data: bytes, error: readError } = await tryAsync({
				try: async () =>
					new Uint8Array(
						await new Blob(pieces, { type: capture.type }).arrayBuffer(),
					),
				catch: (cause) => RecorderError.Failed({ cause }),
			});
			if (readError !== null) return Err(readError);
			// Lands once, whole: the folder keeps it until it does.
			const { error: writeError } = await tryAsync({
				try: () => files.set(file, bytes),
				catch: (cause) => RecorderError.Failed({ cause }),
			});
			if (writeError !== null) return Err(writeError);
			return Ok({
				path: `${path}.${file.ext}`,
				durationMs: finished.data.durationMs,
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
const openMeter: Recorder['openMeter'] = async ({ input, signal } = {}) => {
	if (typeof AudioContext === 'undefined')
		return RecorderError.Unavailable({
			reason: 'this window cannot measure audio',
		});
	const { data: stream, error: openError } = await openMicrophone(
		input,
		signal,
	);
	if (openError !== null) return Err(openError);
	const signals = createSignals();
	const { data: stopMeter, error: meterError } = meter(stream, signals.level);
	if (meterError !== null) {
		release(stream);
		return Err(meterError);
	}
	const track = stream.getAudioTracks()[0];
	// The track ends when its microphone is unplugged or access is withdrawn.
	track?.addEventListener('ended', () => signals.end('deviceDisconnected'));
	let closed = false;
	return Ok({
		microphone: track?.label || input?.label || '',
		onLevel: signals.onLevel,
		onEnded: signals.onEnded,
		async close() {
			if (closed) return;
			closed = true;
			signals.retire();
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
const allow: NonNullable<Recorder['allow']> = async ({ signal } = {}) => {
	const { data: stream, error } = await openMicrophone(undefined, signal);
	if (error !== null) return Err(error);
	release(stream);
	return Ok(undefined);
};

/**
 * IDs a browser lists for "whatever the system uses". They are not a
 * microphone to choose by name: no input, the system default, covers them.
 */
const SYSTEM_ALIASES = new Set(['default', 'communications']);

/**
 * The audio inputs the browser lists now, by name, leaving out its system
 * aliases. Opens nothing and never asks for access: until access is
 * allowed a browser names none, which `namesWithheld` says.
 */
const listInputs: Recorder['listInputs'] = async () => {
	const devices = mediaDevices();
	if (devices?.enumerateDevices === undefined)
		return RecorderError.Unavailable({
			reason: 'this window has no microphone access',
		});
	const { data: found, error } = await tryAsync({
		try: () => devices.enumerateDevices(),
		catch: (cause) => RecorderError.Failed({ cause }),
	});
	if (error !== null) return Err(error);
	const audioInputs = found.filter((device) => device.kind === 'audioinput');
	return Ok({
		inputs: audioInputs
			.filter(
				(device) =>
					device.deviceId !== '' &&
					device.label !== '' &&
					!SYSTEM_ALIASES.has(device.deviceId),
			)
			.map(({ deviceId, label }) => ({ deviceId, label })),
		namesWithheld:
			audioInputs.length > 0 &&
			audioInputs.every((device) => device.label === ''),
	});
};

/** Hear inputs connected or removed, where the browser announces it. */
const onInputsChange: NonNullable<Recorder['onInputsChange']> = (listener) => {
	const devices = mediaDevices();
	if (devices?.addEventListener === undefined) return () => {};
	devices.addEventListener('devicechange', listener);
	return () => devices.removeEventListener('devicechange', listener);
};

/** This tab's microphones, read from the browser at each call. */
export const recorder = {
	start,
	listInputs,
	openMeter,
	allow,
	onInputsChange,
} satisfies Recorder;
