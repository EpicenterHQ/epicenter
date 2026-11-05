/**
 * The browser recorder over fakes of the browser's microphone, encoder,
 * audio graph, and clock, each put in place of the global it stands for for
 * one test, and over a folder in memory whose `audio` is at
 * `recordings/{id}.{ext}`.
 *
 * Key behaviors:
 * - A take lands once, whole, at `<path>.<ext>` when it stops: every piece
 *   the recorder handed over, in order, and nothing at the path before Stop
 * - A file already at the path is refused before any microphone opens
 * - The duration is the recorder's own clock, from its start to its stop,
 *   with its pauses left out, not the time between start and Stop
 * - A take that captured nothing writes nothing and is `Empty`; a second
 *   stop is `NotRecording`
 * - A write the folder will not make, and audio the page cannot read, are
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
import { defineContract } from '@epicenter/definition/contract';
import { openFolder } from '@epicenter/folder';
import { FolderClosed } from '@epicenter/folder/core';
import { memory, memoryFiles } from '@epicenter/folder/memory';
import { expectErr, expectOk } from 'wellcrafted/testing';
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
const folders: Disposable[] = [];

afterEach(() => {
	for (const restore of restorations.splice(0).reverse()) restore();
	for (const folder of folders.splice(0)) folder[Symbol.dispose]();
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

const contract = defineContract({
	collections: { audio: { path: 'recordings/{id}.{ext}' } },
});

/** A folder in memory with its `audio` files, connected, so its reads answer. */
async function audioFolder() {
	const place = memory();
	const folder = openFolder(contract, place);
	folders.push(folder);
	expectOk(await folder.audio.list());
	return { folder, place };
}

/** The bytes `folder` holds at `recordings/a.<ext>`, or null. */
async function bytesAt(
	folder: ReturnType<typeof openFolder<typeof contract>>,
	ext: string,
) {
	return expectOk(await folder.audio.read({ id: 'a', ext }))?.bytes ?? null;
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

/** Start recording at `recordings/a` into a new folder, in a browser set up with `options`. */
async function startIn(
	options: Parameters<typeof browser>[0] = {},
	start: {
		input?: { deviceId: string; label: string };
		signal?: AbortSignal;
	} = {},
) {
	const { folder } = await audioFolder();
	browser(options);
	return recorder.start({ files: folder.audio, path: 'recordings/a', ...start });
}

test('a take lands once, whole, at its path when it stops, with every piece in order', async () => {
	const { folder, place } = await audioFolder();
	const { tick } = browser({
		Recorder: fakeRecorderClass(() => new Uint8Array([9])),
	});
	const recording = expectOk(
		await recorder.start({ files: folder.audio, path: 'recordings/a' }),
	);
	recorders.at(-1)!.piece(new Uint8Array([1, 2]));
	recorders.at(-1)!.piece(new Uint8Array([3]));
	tick(1_500);
	await Bun.sleep(5);
	// Kept in memory until Stop: nothing is at the path yet.
	expect(memoryFiles(place).paths()).toEqual([]);

	expect(expectOk(await recording.stop())).toEqual({
		path: 'recordings/a.webm',
		durationMs: 1_500,
	});
	// Written when Stop answers.
	expect(memoryFiles(place).paths()).toEqual(['recordings/a.webm']);
	expect(await bytesAt(folder, 'webm')).toEqual(
		new Uint8Array([1, 2, 3, 9]),
	);
	expect(expectErr(await recording.stop()).name).toBe('NotRecording');
	expect(memoryFiles(place).paths()).toEqual(['recordings/a.webm']);
});

test('the duration is the recorder’s own clock, with its pauses left out', async () => {
	const { folder } = await audioFolder();
	const { tick } = browser();
	const recording = expectOk(
		await recorder.start({ files: folder.audio, path: 'recordings/a' }),
	);
	tick(1_000);
	recorders.at(-1)!.pause();
	tick(4_000);
	recorders.at(-1)!.resume();
	tick(500);
	expect(expectOk(await recording.stop()).durationMs).toBe(1_500);
});

test('the clock starts when the recorder says it started, not when start was asked', async () => {
	const { folder } = await audioFolder();
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
		await recorder.start({ files: folder.audio, path: 'recordings/a' }),
	);
	tick(300);
	started();
	tick(1_000);
	expect(expectOk(await recording.stop()).durationMs).toBe(1_000);
});

test('AAC in MP4 is recorded into <path>.m4a where the browser records it', async () => {
	const { folder } = await audioFolder();
	browser({
		Recorder: fakeRecorderClass(
			() => new Uint8Array([4, 5]),
			['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2'],
		),
	});
	const recording = expectOk(
		await recorder.start({ files: folder.audio, path: 'recordings/a' }),
	);
	expect(expectOk(await recording.stop()).path).toBe('recordings/a.m4a');
	expect(await bytesAt(folder, 'm4a')).toEqual(new Uint8Array([4, 5]));
});

test('the file is named by the type the recorder reports, however it spells it', async () => {
	for (const [reported, extension] of [
		[' Video/MP4 ; codecs=mp4a.40.2', 'm4a'],
		['audio/webm', 'webm'],
		['', 'webm'],
	] as const) {
		const { folder, place } = await audioFolder();
		browser({
			Recorder: fakeRecorderClass(
				() => new Uint8Array([1]),
				undefined,
				reported,
			),
		});
		const recording = expectOk(
			await recorder.start({ files: folder.audio, path: 'recordings/a' }),
		);
		expect(expectOk(await recording.stop()).path).toBe(
			`recordings/a.${extension}`,
		);
		expect(memoryFiles(place).paths()).toEqual([`recordings/a.${extension}`]);
	}
});

test('a file already at the path is refused before the microphone opens, and kept', async () => {
	const { folder, place } = await audioFolder();
	await memoryFiles(place).write('recordings/a.webm', new Uint8Array([7]));
	expectOk(await folder.audio.list());
	let opened = 0;
	browser({
		async getUserMedia() {
			opened++;
			return fakeStream('default').stream;
		},
	});
	const refused = expectErr(
		await recorder.start({ files: folder.audio, path: 'recordings/a' }),
	);
	expect(refused.name).toBe('Refused');
	expect(opened).toBe(0);
	expect(await bytesAt(folder, 'webm')).toEqual(new Uint8Array([7]));
});

test('a take that captured nothing writes nothing and is Empty', async () => {
	const { folder, place } = await audioFolder();
	const { stream, track } = fakeStream('default');
	browser({
		getUserMedia: async () => stream,
		Recorder: fakeRecorderClass(() => new Uint8Array()),
	});
	const recording = expectOk(
		await recorder.start({ files: folder.audio, path: 'recordings/a' }),
	);
	expect(expectErr(await recording.stop()).name).toBe('Empty');
	expect(track.stopped).toBe(true);
	expect(memoryFiles(place).paths()).toEqual([]);
});

test('a write the folder will not make is a failure, and the microphone is released', async () => {
	// The folder goes while the write waits: the write rejects with `FolderClosed`.
	{
		const { folder, place } = await audioFolder();
		const { stream, track } = fakeStream('default');
		browser({ getUserMedia: async () => stream });
		const recording = expectOk(
			await recorder.start({ files: folder.audio, path: 'recordings/a' }),
		);
		memoryFiles(place).hold();
		const stopping = recording.stop();
		await Bun.sleep(5);
		folder[Symbol.dispose]();
		const failed = expectErr(await stopping);
		expect(failed.name).toBe('Failed');
		expect((failed as { cause: unknown }).cause).toBeInstanceOf(FolderClosed);
		expect(track.stopped).toBe(true);
		expect(memoryFiles(place).paths()).toEqual([]);
	}
	// The folder went while the take ran: the write has nowhere to land.
	{
		const { folder, place } = await audioFolder();
		const { stream, track } = fakeStream('default');
		browser({ getUserMedia: async () => stream });
		const recording = expectOk(
			await recorder.start({ files: folder.audio, path: 'recordings/a' }),
		);
		folder[Symbol.dispose]();
		expect(expectErr(await recording.stop()).name).toBe('Failed');
		expect(track.stopped).toBe(true);
		expect(memoryFiles(place).paths()).toEqual([]);
	}
});

test('audio the page cannot read is a failure, not a thrown stop, and the microphone is still released', async () => {
	const { folder, place } = await audioFolder();
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
		await recorder.start({ files: folder.audio, path: 'recordings/a' }),
	);
	recorders.at(-1)!.piece(new Uint8Array([1]));
	expect(expectErr(await recording.stop())).toMatchObject({
		name: 'Failed',
		cause: unreadable,
	});
	expect(track.stopped).toBe(true);
	expect(memoryFiles(place).paths()).toEqual([]);
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
			recorder.start({ files, path: 'recordings/a', signal }),
		(_: AudioFiles, signal: AbortSignal) => recorder.openMeter({ signal }),
		(_: AudioFiles, signal: AbortSignal) => recorder.allow({ signal }),
	]) {
		const { folder } = await audioFolder();
		const { stream, track } = fakeStream('default');
		const controller = new AbortController();
		browser({
			async getUserMedia() {
				controller.abort();
				return stream;
			},
		});
		expect(expectErr(await request(folder.audio, controller.signal)).name).toBe(
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
		const { folder, place } = await audioFolder();
		const { stream, track } = fakeStream('default');
		browser({ getUserMedia: async () => stream, Recorder });
		expect(
			expectErr(
				await recorder.start({ files: folder.audio, path: 'recordings/a' }),
			).name,
		).toBe('Failed');
		expect(track.stopped).toBe(true);
		expect(memoryFiles(place).paths()).toEqual([]);
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
		const { folder } = await audioFolder();
		browser();
		stub(target, key, undefined);
		expect(
			expectErr(
				await recorder.start({ files: folder.audio, path: 'recordings/a' }),
			).name,
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
	const { folder } = await audioFolder();
	const { stream, track } = fakeStream('default');
	const { tick } = browser({ getUserMedia: async () => stream });
	const recording = expectOk(
		await recorder.start({ files: folder.audio, path: 'recordings/a' }),
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
		path: 'recordings/a.webm',
		durationMs: 2_000,
	});
	expect(await bytesAt(folder, 'webm')).toEqual(
		new Uint8Array([7, 1, 2, 3]),
	);
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
