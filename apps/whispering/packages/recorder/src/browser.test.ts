/**
 * The browser recorder over fakes of the browser's microphone, encoder,
 * audio graph, and clock, each put in place of the global it stands for for
 * one test, and over Whispering's files in memory.
 *
 * Key behaviors:
 * - A take lands once, whole, at `<path>.<ext>` when it stops: every piece
 *   the recorder handed over, in order, and nothing at the path before Stop
 * - The duration is the recorder's own clock, from its start to its stop,
 *   with its pauses left out, not the time between start and Stop
 * - A take that captured nothing writes nothing and is `Empty`; a second
 *   stop is `NotRecording`
 * - A write the files will not make, and audio the page cannot read, are
 *   `Failed`, with the microphone released
 * - The file is named by the type the browser produced: AAC in MP4 (`m4a`),
 *   else Opus in WebM (`webm`)
 * - A chosen microphone that cannot be opened exactly is refused, never
 *   replaced, and anything opened is released
 * - A start withdrawn while the browser answers releases what arrives late
 * - A lost microphone ends a recording, which keeps what was recorded and
 *   stops its clock there
 * - A meter opens one microphone for its level only, ends when it is
 *   unplugged, and releases it on close; enabling access opens the default
 *   and releases it at once
 * - Listing opens nothing, names the audio inputs without the system
 *   aliases, and says when the browser withholds their names; inputs
 *   connected or removed are heard until the listener is removed
 */
import { afterEach, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { failed as failedWrite } from '../../../src/lib/files/files.js';
import { memoryFiles } from '../../../src/lib/files/memory.js';
import { recorder } from './browser.js';
import type { AudioFiles } from './recording.js';

/** What every microphone request turns off: Safari's voice processing. */
const UNPROCESSED = {
	echoCancellation: false,
	noiseSuppression: false,
	autoGainControl: false,
};

type Track = {
	stopped: boolean;
	readonly label: string;
	stop(): void;
	getSettings(): { deviceId: string };
	addEventListener(type: string, listener: () => void): void;
	end(): void;
};

function fakeStream(deviceId: string, label = 'Desk Microphone') {
	const ended: (() => void)[] = [];
	const track: Track = {
		stopped: false,
		label,
		stop() {
			this.stopped = true;
		},
		getSettings: () => ({ deviceId }),
		addEventListener(type, listener) {
			if (type === 'ended') ended.push(listener);
		},
		end() {
			for (const listener of ended) listener();
		},
	};
	const stream = {
		getTracks: () => [track],
		getAudioTracks: () => [track],
	} as unknown as MediaStream;
	return { stream, track };
}

/** The fake recorders made, newest last, for a test to act as the browser through. */
const recorders: {
	piece(bytes: Uint8Array): void;
	pause(): void;
	resume(): void;
}[] = [];

/**
 * A MediaRecorder that records the `supported` types, says `start`,
 * `pause`, `resume`, and `stop` as a browser does, and hands over
 * `produced` as its last piece when it stops. It reports producing
 * `reports`, whatever it was asked for, or else what it was asked for.
 * Like a browser's, it stops itself when its track ends.
 */
function fakeRecorderClass(
	produced: () => Uint8Array = () => new Uint8Array([1, 2, 3]),
	supported: readonly string[] = ['audio/webm;codecs=opus'],
	reports?: string,
) {
	return class FakeRecorder {
		static isTypeSupported(type: string) {
			return supported.includes(type);
		}
		readonly mimeType: string;
		readonly listeners = new Map<string, ((event: unknown) => void)[]>();
		state: RecordingState = 'inactive';
		constructor(stream: MediaStream, options?: MediaRecorderOptions) {
			for (const track of stream.getAudioTracks())
				track.addEventListener('ended', () =>
					queueMicrotask(() => {
						if (this.state !== 'inactive') this.stop();
					}),
				);
			this.mimeType = reports ?? options?.mimeType ?? '';
			recorders.push(this);
		}
		addEventListener(type: string, listener: (event: unknown) => void) {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
		}
		dispatch(type: string, event: unknown = {}) {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
		/** Hand over a piece while recording, as the browser does each second. */
		piece(bytes: Uint8Array) {
			this.dispatch('dataavailable', {
				data: new Blob([bytes as BlobPart], { type: this.mimeType }),
			});
		}
		start() {
			this.state = 'recording';
			this.dispatch('start');
		}
		pause() {
			this.state = 'paused';
			this.dispatch('pause');
		}
		resume() {
			this.state = 'recording';
			this.dispatch('resume');
		}
		stop() {
			if (this.state === 'inactive') throw new Error('InvalidStateError');
			this.state = 'inactive';
			this.piece(produced());
			this.dispatch('stop');
		}
	};
}

const restorations: (() => void)[] = [];

afterEach(() => {
	for (const restore of restorations.splice(0).reverse()) restore();
});

/** Put `value` at `target[key]` until the test ends. */
function stub(target: object, key: PropertyKey, value: unknown) {
	const original = Object.getOwnPropertyDescriptor(target, key);
	Object.defineProperty(target, key, { configurable: true, value });
	restorations.push(() => {
		if (original) Object.defineProperty(target, key, original);
		else Reflect.deleteProperty(target, key);
	});
}

/** An audio graph whose analyser always hears half scale. */
class FakeAudioContext {
	createMediaStreamSource() {
		return { connect() {}, disconnect() {} };
	}
	createAnalyser() {
		return {
			fftSize: 0,
			getFloatTimeDomainData(samples: Float32Array) {
				samples.fill(0.5);
			},
		};
	}
	async resume() {}
	async close() {}
}

/** Whispering's files in memory, as a recording is written into them. */
function audioFolder() {
	const files = memoryFiles();
	const audio: AudioFiles = {
		location: null,
		write: files.write,
	};
	return { audio, files };
}

/** The audio files `files` holds, by path. */
async function paths(files: ReturnType<typeof memoryFiles>) {
	return expectOk(await files.list('recordings')).map(
		({ name }) => `recordings/${name}`,
	);
}

/** The bytes `files` holds at `recordings/a.<ext>`, or null. */
async function bytesAt(files: ReturnType<typeof memoryFiles>, ext: string) {
	return expectOk(await files.read(`recordings/a.${ext}`));
}

/**
 * The browser this test records in: a microphone answering `getUserMedia`,
 * the encoder `Recorder`, an audio graph, and a clock at 1 s that `tick`
 * moves on.
 */
function browser({
	getUserMedia = async () => fakeStream('default').stream,
	Recorder = fakeRecorderClass(),
}: {
	getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	Recorder?: ReturnType<typeof fakeRecorderClass>;
} = {}) {
	stub(navigator, 'mediaDevices', { getUserMedia });
	stub(globalThis, 'MediaRecorder', Recorder);
	stub(globalThis, 'AudioContext', FakeAudioContext);
	let clock = 1_000;
	stub(performance, 'now', () => clock);
	return {
		/** Move the clock on `ms`. */
		tick(ms: number) {
			clock += ms;
		},
	};
}

/** Start recording `a` into new files, in a browser set up with `options`. */
async function startIn(
	options: Parameters<typeof browser>[0] = {},
	start: {
		input?: { deviceId: string; label: string };
		signal?: AbortSignal;
	} = {},
) {
	const { audio } = audioFolder();
	browser(options);
	return recorder.start({
		files: audio,
		id: 'a',
		...start,
	});
}

test('a take lands once, whole, at its path when it stops, with every piece in order', async () => {
	const { audio, files } = audioFolder();
	const { tick } = browser({
		Recorder: fakeRecorderClass(() => new Uint8Array([9])),
	});
	const recording = expectOk(
		await recorder.start({ files: audio, id: 'a' }),
	);
	recorders.at(-1)!.piece(new Uint8Array([1, 2]));
	recorders.at(-1)!.piece(new Uint8Array([3]));
	tick(1_500);
	await Bun.sleep(5);
	// Kept in memory until Stop: nothing is at the path yet.
	expect(await paths(files)).toEqual([]);

	expect(expectOk(await recording.stop())).toEqual({
		id: 'a',
		durationMs: 1_500,
	});
	// Written when Stop answers.
	expect(await paths(files)).toEqual(['recordings/a.webm']);
	expect(await bytesAt(files, 'webm')).toEqual(new Uint8Array([1, 2, 3, 9]));
	expect(expectErr(await recording.stop()).name).toBe('NotRecording');
	expect(await paths(files)).toEqual(['recordings/a.webm']);
});

test('the duration is the recorder’s own clock, with its pauses left out', async () => {
	const { audio } = audioFolder();
	const { tick } = browser();
	const recording = expectOk(
		await recorder.start({ files: audio, id: 'a' }),
	);
	tick(1_000);
	recorders.at(-1)!.pause();
	tick(4_000);
	recorders.at(-1)!.resume();
	tick(500);
	expect(expectOk(await recording.stop()).durationMs).toBe(1_500);
});

test('the clock starts when the recorder says it started, not when start was asked', async () => {
	const { audio } = audioFolder();
	let started = () => {};
	const Base = fakeRecorderClass();
	const { tick } = browser({
		// A browser that says `start` a moment after it is asked.
		Recorder: class extends Base {
			override start() {
				this.state = 'recording';
				started = () => this.dispatch('start');
			}
		},
	});
	const recording = expectOk(
		await recorder.start({ files: audio, id: 'a' }),
	);
	tick(300);
	started();
	tick(1_000);
	expect(expectOk(await recording.stop()).durationMs).toBe(1_000);
});

test('AAC in MP4 is recorded into <id>.m4a where the browser records it', async () => {
	const { audio, files } = audioFolder();
	browser({
		Recorder: fakeRecorderClass(
			() => new Uint8Array([4, 5]),
			['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2'],
		),
	});
	const recording = expectOk(
		await recorder.start({ files: audio, id: 'a' }),
	);
	expect(expectOk(await recording.stop()).id).toBe('a');
	expect(await bytesAt(files, 'm4a')).toEqual(new Uint8Array([4, 5]));
});

test('the file is named by the type the recorder reports, however it spells it', async () => {
	for (const [reported, extension] of [
		[' Video/MP4 ; codecs=mp4a.40.2', 'm4a'],
		['audio/webm', 'webm'],
		['', 'webm'],
	] as const) {
		const { audio, files } = audioFolder();
		browser({
			Recorder: fakeRecorderClass(
				() => new Uint8Array([1]),
				undefined,
				reported,
			),
		});
		const recording = expectOk(
			await recorder.start({ files: audio, id: 'a' }),
		);
		expectOk(await recording.stop());
		expect(await paths(files)).toEqual([`recordings/a.${extension}`]);
	}
});

test('a take that captured nothing writes nothing and is Empty', async () => {
	const { audio, files } = audioFolder();
	const { stream, track } = fakeStream('default');
	browser({
		getUserMedia: async () => stream,
		Recorder: fakeRecorderClass(() => new Uint8Array()),
	});
	const recording = expectOk(
		await recorder.start({ files: audio, id: 'a' }),
	);
	expect(expectErr(await recording.stop()).name).toBe('Empty');
	expect(track.stopped).toBe(true);
	expect(await paths(files)).toEqual([]);
});

test('a write the files will not make is a failure, and the microphone is released', async () => {
	const { audio, files } = audioFolder();
	const refusal = failedWrite('the disk is full');
	const { stream, track } = fakeStream('default');
	browser({ getUserMedia: async () => stream });
	const recording = expectOk(
		await recorder.start({
			files: { ...audio, write: async () => refusal },
			id: 'a',
		}),
	);
	recorders.at(-1)!.piece(new Uint8Array([1]));
	const failed = expectErr(await recording.stop());
	expect(failed.name).toBe('Failed');
	expect((failed as { cause: unknown }).cause).toBe(refusal.error);
	expect(track.stopped).toBe(true);
	expect(await paths(files)).toEqual([]);
});

test('audio the page cannot read is a failure, not a thrown stop, and the microphone is still released', async () => {
	const { audio, files } = audioFolder();
	const unreadable = new Error('NotReadableError');
	class UnreadableBlob extends Blob {
		override async arrayBuffer(): Promise<ArrayBuffer> {
			throw unreadable;
		}
	}
	stub(globalThis, 'Blob', UnreadableBlob);
	const { stream, track } = fakeStream('default');
	browser({ getUserMedia: async () => stream });
	const recording = expectOk(
		await recorder.start({ files: audio, id: 'a' }),
	);
	recorders.at(-1)!.piece(new Uint8Array([1]));
	expect(expectErr(await recording.stop())).toMatchObject({
		name: 'Failed',
		cause: unreadable,
	});
	expect(track.stopped).toBe(true);
	expect(await paths(files)).toEqual([]);
});

test('a chosen microphone is asked for exactly, and refused rather than replaced', async () => {
	const asked: MediaStreamConstraints[] = [];
	const input = { deviceId: 'usb-1', label: 'USB Mic' };
	const refused = expectErr(
		await startIn(
			{
				async getUserMedia(constraints) {
					asked.push(constraints);
					throw Object.assign(new Error('gone'), {
						name: 'OverconstrainedError',
					});
				},
			},
			{ input },
		),
	);
	expect(refused).toMatchObject({ name: 'InputUnavailable', label: 'USB Mic' });
	expect(asked).toEqual([
		{ audio: { ...UNPROCESSED, deviceId: { exact: 'usb-1' } } },
	]);

	const other = fakeStream('built-in');
	expect(
		expectErr(
			await startIn({ getUserMedia: async () => other.stream }, { input }),
		).name,
	).toBe('InputUnavailable');
	expect(other.track.stopped).toBe(true);
});

test('refused access and a missing default microphone are refusals of their own, for recording, enabling, and a meter', async () => {
	for (const [thrown, expected] of [
		['NotAllowedError', 'PermissionDenied'],
		['SecurityError', 'PermissionDenied'],
		['NotFoundError', 'NoInputDevice'],
		['NotReadableError', 'Failed'],
	] as const) {
		expect(
			expectErr(
				await startIn({
					async getUserMedia() {
						throw Object.assign(new Error('no'), { name: thrown });
					},
				}),
			).name,
		).toBe(expected);
		expect(expectErr(await recorder.allow()).name).toBe(expected);
		expect(expectErr(await recorder.openMeter()).name).toBe(expected);
	}
});

test('stop releases the microphone, and a second stop is NotRecording', async () => {
	const { stream, track } = fakeStream('default');
	const recording = expectOk(
		await startIn({ getUserMedia: async () => stream }),
	);
	expectOk(await recording.stop());
	expect(track.stopped).toBe(true);
	expect(expectErr(await recording.stop()).name).toBe('NotRecording');
});

test('a start, a meter, or enabling withdrawn while the browser answers releases the late stream', async () => {
	for (const request of [
		(files: AudioFiles, signal: AbortSignal) =>
			recorder.start({ files, id: 'a', signal }),
		(_: AudioFiles, signal: AbortSignal) => recorder.openMeter({ signal }),
		(_: AudioFiles, signal: AbortSignal) => recorder.allow({ signal }),
	]) {
		const { audio } = audioFolder();
		const { stream, track } = fakeStream('default');
		const controller = new AbortController();
		browser({
			async getUserMedia() {
				controller.abort();
				return stream;
			},
		});
		expect(expectErr(await request(audio, controller.signal)).name).toBe(
			'Cancelled',
		);
		expect(track.stopped).toBe(true);
	}
});

test('an encoder that cannot be made, started, or stopped is a failure, and the microphone is released', async () => {
	const Base = fakeRecorderClass();
	const unmade = class extends Base {
		constructor(stream: MediaStream, options?: MediaRecorderOptions) {
			super(stream, options);
			throw new Error('NotSupportedError');
		}
	};
	const unstarted = class extends Base {
		override start(): void {
			throw new Error('InvalidStateError');
		}
	};
	for (const Recorder of [unmade, unstarted]) {
		const { audio, files } = audioFolder();
		const { stream, track } = fakeStream('default');
		browser({ getUserMedia: async () => stream, Recorder });
		expect(
			expectErr(await recorder.start({ files: audio, id: 'a' }))
				.name,
		).toBe('Failed');
		expect(track.stopped).toBe(true);
		expect(await paths(files)).toEqual([]);
	}

	// One that will not stop never says it stopped: Stop answers anyway.
	const { stream, track } = fakeStream('default');
	const recording = expectOk(
		await startIn({
			getUserMedia: async () => stream,
			Recorder: class extends Base {
				override stop(): void {
					throw new Error('InvalidStateError');
				}
			},
		}),
	);
	expect(expectErr(await recording.stop()).name).toBe('Failed');
	expect(track.stopped).toBe(true);
});

test('a window without a microphone, an encoder, or MP4 or WebM audio cannot record', async () => {
	for (const [target, key] of [
		[navigator, 'mediaDevices'],
		[globalThis, 'MediaRecorder'],
	] as const) {
		const { audio } = audioFolder();
		browser();
		stub(target, key, undefined);
		expect(
			expectErr(await recorder.start({ files: audio, id: 'a' }))
				.name,
		).toBe('Unavailable');
	}
	expect(
		expectErr(
			await startIn({
				Recorder: fakeRecorderClass(() => new Uint8Array([1]), []),
			}),
		).name,
	).toBe('Unavailable');
});

test('a lost microphone ends a recording, which keeps what was recorded and stops its clock there', async () => {
	const { audio, files } = audioFolder();
	const { stream, track } = fakeStream('default');
	const { tick } = browser({ getUserMedia: async () => stream });
	const recording = expectOk(
		await recorder.start({ files: audio, id: 'a' }),
	);
	recorders.at(-1)!.piece(new Uint8Array([7]));
	tick(2_000);
	track.end();
	tick(5_000);
	await Promise.resolve();
	// Heard by a listener that subscribes after the ending.
	const endings: string[] = [];
	recording.onEnded((reason) => endings.push(reason));
	expect(endings).toEqual(['deviceDisconnected']);
	expect(expectOk(await recording.stop())).toEqual({
		id: 'a',
		durationMs: 2_000,
	});
	expect(await bytesAt(files, 'webm')).toEqual(new Uint8Array([7, 1, 2, 3]));
	const late: string[] = [];
	recording.onEnded((reason) => late.push(reason));
	track.end();
	expect(late).toEqual([]);
});

test('an ending reaches every listener when the first listener stops the browser recorder', async () => {
	const { stream, track } = fakeStream('default');
	const recording = expectOk(
		await startIn({ getUserMedia: async () => stream }),
	);
	let stopping: ReturnType<typeof recording.stop> | undefined;
	const endings: string[] = [];
	recording.onEnded(() => {
		stopping = recording.stop();
	});
	recording.onEnded((reason) => endings.push(reason));
	track.end();
	expect(endings).toEqual(['deviceDisconnected']);
	expect(stopping).toBeDefined();
	expectOk(await stopping!);
});

test('a meter opens exactly the chosen microphone for its level, ends when it is unplugged, and releases it on close', async () => {
	const asked: MediaStreamConstraints[] = [];
	const { stream, track } = fakeStream('usb-1', 'USB Mic');
	browser({
		async getUserMedia(constraints) {
			asked.push(constraints);
			return stream;
		},
	});
	const meter = expectOk(
		await recorder.openMeter({
			input: { deviceId: 'usb-1', label: 'USB Mic' },
		}),
	);
	expect(asked).toEqual([
		{ audio: { ...UNPROCESSED, deviceId: { exact: 'usb-1' } } },
	]);
	expect(meter.microphone).toBe('USB Mic');
	const levels: number[] = [];
	meter.onLevel((level) => levels.push(level));
	await new Promise((resolve) => setTimeout(resolve, 120));
	expect(levels[0]).toBeCloseTo(0.5);

	track.end();
	const endings: string[] = [];
	meter.onEnded((reason) => endings.push(reason));
	expect(endings).toEqual(['deviceDisconnected']);
	await meter.close();
	expect(track.stopped).toBe(true);
	const heard = levels.length;
	await new Promise((resolve) => setTimeout(resolve, 120));
	expect(levels.length).toBe(heard);
});

test('enabling access opens the default microphone and releases it at once, and a window that cannot measure audio has no meter', async () => {
	const asked: MediaStreamConstraints[] = [];
	const { stream, track } = fakeStream('default');
	browser({
		async getUserMedia(constraints) {
			asked.push(constraints);
			return stream;
		},
	});
	expectOk(await recorder.allow());
	expect(asked).toEqual([{ audio: UNPROCESSED }]);
	expect(track.stopped).toBe(true);

	stub(globalThis, 'AudioContext', undefined);
	expect(expectErr(await recorder.openMeter()).name).toBe('Unavailable');
	expect(asked).toHaveLength(1);
});

/** A browser listing `devices`, with the listeners it tells of a change. */
function listing(devices: { kind: string; deviceId: string; label: string }[]) {
	const asked: MediaStreamConstraints[] = [];
	const changeListeners = new Set<() => void>();
	stub(navigator, 'mediaDevices', {
		async getUserMedia(constraints: MediaStreamConstraints) {
			asked.push(constraints);
			return fakeStream('default').stream;
		},
		enumerateDevices: async () => devices,
		addEventListener: (_type: string, listener: () => void) =>
			changeListeners.add(listener),
		removeEventListener: (_type: string, listener: () => void) =>
			changeListeners.delete(listener),
	});
	return { asked, changeListeners };
}

test('listing opens no microphone, names the audio inputs, and leaves out the system aliases', async () => {
	const { asked } = listing([
		{ kind: 'audioinput', deviceId: 'default', label: 'Default - Desk' },
		{ kind: 'audioinput', deviceId: 'communications', label: 'Comms - Desk' },
		{ kind: 'audioinput', deviceId: 'desk', label: 'Desk Microphone' },
		{ kind: 'audioinput', deviceId: 'usb-1', label: 'USB Mic' },
		{ kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' },
	]);
	expect(expectOk(await recorder.listInputs())).toEqual({
		inputs: [
			{ deviceId: 'desk', label: 'Desk Microphone' },
			{ deviceId: 'usb-1', label: 'USB Mic' },
		],
		namesWithheld: false,
	});
	expect(asked).toEqual([]);
});

test('before access is allowed, withheld names are said and nothing is listed by name', async () => {
	listing([{ kind: 'audioinput', deviceId: '', label: '' }]);
	expect(expectOk(await recorder.listInputs())).toEqual({
		inputs: [],
		namesWithheld: true,
	});
	listing([{ kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' }]);
	expect(expectOk(await recorder.listInputs())).toEqual({
		inputs: [],
		namesWithheld: false,
	});
});

test('inputs connected or removed are heard until the listener is removed, and a window without microphone access lists nothing', async () => {
	const { changeListeners } = listing([]);
	let heard = 0;
	const stop = recorder.onInputsChange(() => (heard += 1));
	for (const listener of changeListeners) listener();
	stop();
	expect(heard).toBe(1);
	expect(changeListeners.size).toBe(0);

	stub(navigator, 'mediaDevices', undefined);
	expect(expectErr(await recorder.listInputs()).name).toBe('Unavailable');
	expect(expectErr(await recorder.allow()).name).toBe('Unavailable');
	// Nothing to hear about, and nothing to undo.
	recorder.onInputsChange(() => {})();
});
