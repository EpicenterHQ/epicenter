/**
 * The browser recorder over fakes of the browser's microphone, encoder,
 * audio graph, clock, and locks, each put in place of the global it stands
 * for for one test, and over a store's files kept in memory.
 *
 * Key behaviors:
 * - A recording is written into the store as it records: the first piece
 *   makes `<path>.<ext>`, each later one is appended the moment it arrives,
 *   and the store's listeners hear the file made and finished, not each piece
 * - A folder that keeps no files in this browser, a store that keeps none
 *   here, or a file already at the path, is refused before any microphone
 *   opens
 * - A store that stops taking pieces ends the recording (`storageFailed`),
 *   keeping what landed
 * - Recovery cuts a file a closed tab left half-written back to its last
 *   whole piece, answers how long it plays, and leaves a recording another
 *   tab is writing alone
 * - A recording held in the page answers its audio at stop, named by the
 *   type the browser produced: AAC in MP4 (`m4a`), else Opus in WebM (`webm`)
 * - A chosen microphone that cannot be opened exactly is refused, never
 *   replaced, and anything opened is released
 * - Stop answers how long the written audio plays, read from its bytes,
 *   not the time between start and stop
 * - Stop releases the microphone; a second stop is `NotRecording`
 * - A start withdrawn while the browser answers releases what arrives late
 * - A lost microphone ends a recording
 * - A meter opens one microphone for its level only, ends when it is
 *   unplugged, and releases it on close; enabling access opens the default
 *   and releases it at once
 * - Listing opens nothing, names the audio inputs without the system
 *   aliases, and says when the browser withholds their names; inputs
 *   connected or removed are heard until the listener is removed
 */
import { afterEach, expect, mock, setSystemTime, test } from 'bun:test';
import type { DeviceFiles } from '@epicenter/folder/browser';
import type { FolderLifecycle } from '@epicenter/folder/core';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { audioDurationMs } from './container.js';
import type { Recording } from './recording.js';

/** Each test's store, by the folder its recordings are given. */
const filesByFolder = new WeakMap<object, DeviceFiles>();
mock.module('@epicenter/folder/browser', () => ({
	filesOf: async (folder: object) => filesByFolder.get(folder) ?? null,
}));
const { recorder, startPageRecording } = await import('./browser.js');

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

/** The fake recorders made, newest last, to hand over pieces while they record. */
const recorders: { piece(bytes: Uint8Array): void }[] = [];

/**
 * A MediaRecorder that records the `supported` types and produces `produced`
 * when it stops. It reports producing `reports`, whatever it was asked
 * for, or else what it was asked for.
 */
function fakeRecorderClass(
	produced: () => Uint8Array,
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
		/** Hand over a piece while recording, as the browser does each second. */
		piece(bytes: Uint8Array) {
			for (const listener of this.listeners.get('dataavailable') ?? [])
				listener({
					data: new Blob([bytes as BlobPart], { type: this.mimeType }),
				});
		}
		addEventListener(type: string, listener: (event: unknown) => void) {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
		}
		start() {
			this.state = 'recording';
		}
		stop() {
			if (this.state === 'inactive') throw new Error('InvalidStateError');
			this.state = 'inactive';
			const bytes = produced();
			for (const listener of this.listeners.get('dataavailable') ?? [])
				listener({
					data: new Blob([bytes as BlobPart], { type: this.mimeType }),
				});
			for (const listener of this.listeners.get('stop') ?? []) listener({});
		}
	};
}

const restorations: (() => void)[] = [];

afterEach(() => {
	for (const restore of restorations.splice(0).reverse()) restore();
	setSystemTime();
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

/**
 * The browser this test records in: a microphone answering `getUserMedia`,
 * the encoder `Recorder`, an audio graph, Web Locks when given, and a clock
 * at 1 s that `tick` moves on 1.5 s. Answers the store client recordings are
 * given, over `files` (an empty store unless given).
 */
function browser({
	getUserMedia = async () => fakeStream('default').stream,
	Recorder = fakeRecorderClass(() => new Uint8Array([1, 2, 3])),
	locks,
	files = memoryFiles().files,
}: {
	getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	Recorder?: ReturnType<typeof fakeRecorderClass>;
	locks?: Pick<LockManager, 'request'>;
	files?: DeviceFiles;
} = {}) {
	stub(navigator, 'mediaDevices', { getUserMedia });
	stub(navigator, 'locks', locks);
	stub(globalThis, 'MediaRecorder', Recorder);
	stub(globalThis, 'AudioContext', FakeAudioContext);
	let clock = 1_000;
	setSystemTime(clock);
	const folder = {} as FolderLifecycle;
	filesByFolder.set(folder, files);
	return {
		folder,
		/** Move the clock on 1.5 s. */
		tick() {
			clock += 1_500;
			setSystemTime(clock);
		},
	};
}

/** A store's files in memory, and what its listeners heard. */
function memoryFiles(initial: Record<string, Uint8Array> = {}) {
	const held = new Map(Object.entries(initial));
	const heard: string[] = [];
	let unavailable: string | undefined;
	const refuse = () =>
		({
			data: null,
			error: { name: 'Unavailable', message: unavailable! },
		}) as never;
	const versionOf = (bytes: Uint8Array) => `v${bytes.join('.')}`;
	const files: DeviceFiles = {
		async list() {
			if (unavailable) return refuse();
			return Ok([...held.keys()].map((path) => ({ path, stamp: '' })));
		},
		async read(path) {
			if (unavailable) return refuse();
			const bytes = held.get(path);
			return Ok(
				bytes === undefined
					? null
					: { bytes, version: versionOf(bytes) as never, stamp: '' },
			);
		},
		async write(path, bytes, expected) {
			if (unavailable) return refuse();
			const there = held.get(path);
			// Recovery writes only over the version it read.
			if (
				typeof expected === 'string' ||
				there === undefined ||
				versionOf(there) !== expected.sha256
			)
				return Ok('stale');
			if (bytes === null) held.delete(path);
			else held.set(path, bytes);
			heard.push(`write ${path}`);
			return Ok('landed');
		},
		async append(path, bytes, { create, announce }) {
			if (unavailable) return refuse();
			const there = held.get(path);
			if (create === (there !== undefined)) return Ok('stale');
			held.set(path, new Uint8Array([...(there ?? []), ...bytes]));
			if (create || announce)
				heard.push(`${create ? 'made' : 'finished'} ${path}`);
			return Ok('landed');
		},
	};
	return {
		files,
		held,
		heard,
		/** Every later call is `Unavailable`, as when the browser keeps no files. */
		refuseWith(reason: string) {
			unavailable = reason;
		},
	};
}

/** Web Locks for one origin's tabs: a lock asked for only if available. */
function memoryLocks() {
	const held = new Set<string>();
	return {
		held,
		request(
			name: string,
			_options: LockOptions,
			callback: (lock: Lock | null) => Promise<unknown>,
		) {
			if (held.has(name)) return callback(null);
			held.add(name);
			return callback({ name, mode: 'exclusive' }).finally(() =>
				held.delete(name),
			);
		},
	} as unknown as Pick<LockManager, 'request'> & { held: Set<string> };
}

/** Let queued appends land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Stop `recording` and answer where its audio is. */
async function placedPath(recording: Recording) {
	return expectOk(await recording.stop()).path;
}

test('a recording is written into the store as it records, and heard made and finished', async () => {
	const memory = memoryFiles();
	const { folder, tick } = browser({
		files: memory.files,
		Recorder: fakeRecorderClass(() => new Uint8Array([9])),
	});
	const recording = expectOk(
		await recorder.start({ folder, path: 'recordings/a' }),
	);
	expect(memory.held.has('recordings/a.webm')).toBe(false);

	recorders.at(-1)!.piece(new Uint8Array([1, 2]));
	await settle();
	expect(memory.held.get('recordings/a.webm')).toEqual(new Uint8Array([1, 2]));
	recorders.at(-1)!.piece(new Uint8Array([3]));
	await settle();
	expect(memory.held.get('recordings/a.webm')).toEqual(
		new Uint8Array([1, 2, 3]),
	);
	expect(memory.heard).toEqual(['made recordings/a.webm']);

	tick();
	// Written at its path as it recorded, so it is there when Stop answers.
	expect(expectOk(await recording.stop())).toEqual({
		path: 'recordings/a.webm',
		durationMs: 1_500,
	});
	expect(memory.held.get('recordings/a.webm')).toEqual(
		new Uint8Array([1, 2, 3, 9]),
	);
	expect(memory.heard).toEqual([
		'made recordings/a.webm',
		'finished recordings/a.webm',
	]);
	expect(expectErr(await recording.stop()).name).toBe('NotRecording');
});

test('stop answers how long the written audio plays, not how long the clock ran', async () => {
	// WebKit's second of tone, in the pieces it handed over: the clock says
	// 1.5 s, the file holds a second (Safari drops a recording's first moments).
	const audio = new Uint8Array(
		await Bun.file(
			new URL('./fixtures/webkit.m4a', import.meta.url),
		).arrayBuffer(),
	);
	const cuts = [0, 1829, 1829 + 1255, 1829 + 1255 + 1330, audio.length];
	const memory = memoryFiles();
	const { folder, tick } = browser({
		files: memory.files,
		Recorder: fakeRecorderClass(
			() => audio.slice(cuts[3], cuts[4]),
			['audio/mp4;codecs=mp4a.40.2'],
		),
	});
	const recording = expectOk(
		await recorder.start({ folder, path: 'recordings/a' }),
	);
	for (let piece = 0; piece < 3; piece++)
		recorders.at(-1)!.piece(audio.slice(cuts[piece], cuts[piece + 1]));
	tick();
	expect(expectOk(await recording.stop())).toEqual({
		path: 'recordings/a.m4a',
		durationMs: 1003,
	});
	expect(memory.held.get('recordings/a.m4a')).toEqual(audio);

	const held = expectOk(await startPageRecording());
	recorders.at(-1)!.piece(audio.slice(0, cuts[3]));
	tick();
	expect(expectOk(await held.stop()).durationMs).toBe(1003);
});

test('AAC in MP4 is recorded into <path>.m4a where the browser records it', async () => {
	const memory = memoryFiles();
	const { folder } = browser({
		files: memory.files,
		Recorder: fakeRecorderClass(
			() => new Uint8Array([4, 5]),
			['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2'],
		),
	});
	const recording = expectOk(
		await recorder.start({ folder, path: 'recordings/a' }),
	);
	expect(await placedPath(recording)).toBe('recordings/a.m4a');
	expect(memory.held.get('recordings/a.m4a')).toEqual(new Uint8Array([4, 5]));
});

test('a folder with no files here, a store that keeps none, or a file at the path is refused before the microphone opens', async () => {
	let opened = 0;
	const getUserMedia = async () => {
		opened++;
		return fakeStream('default').stream;
	};
	const privateWindow = memoryFiles();
	privateWindow.refuseWith(
		'This browser gives the page no private file storage',
	);
	const refused = expectErr(
		await recorder.start({
			folder: browser({ files: privateWindow.files, getUserMedia }).folder,
			path: 'recordings/a',
		}),
	);
	expect(refused).toMatchObject({
		name: 'Refused',
		reason: 'This browser gives the page no private file storage',
	});

	const taken = memoryFiles({ 'recordings/a.webm': new Uint8Array([7]) });
	const occupied = expectErr(
		await recorder.start({
			folder: browser({ files: taken.files, getUserMedia }).folder,
			path: 'recordings/a',
		}),
	);
	expect(occupied.name).toBe('Refused');
	expect(taken.held.get('recordings/a.webm')).toEqual(new Uint8Array([7]));

	// A folder that keeps no files in this browser (an account's repository).
	const elsewhere = expectErr(
		await recorder.start({
			folder: {} as FolderLifecycle,
			path: 'recordings/a',
		}),
	);
	expect(elsewhere.name).toBe('Unavailable');
	expect(opened).toBe(0);
});

test('a store that stops taking pieces ends the recording, and stop keeps what landed', async () => {
	const memory = memoryFiles();
	const { folder } = browser({
		files: memory.files,
		Recorder: fakeRecorderClass(() => new Uint8Array([9])),
	});
	const recording = expectOk(
		await recorder.start({ folder, path: 'recordings/a' }),
	);
	const endings: string[] = [];
	recording.onEnded((reason) => endings.push(reason));
	recorders.at(-1)!.piece(new Uint8Array([1]));
	await settle();
	memory.held.delete('recordings/a.webm');
	recorders.at(-1)!.piece(new Uint8Array([2]));
	await settle();
	expect(endings).toEqual(['storageFailed']);
	expect(await placedPath(recording)).toBe('recordings/a.webm');
	expect(memory.held.has('recordings/a.webm')).toBe(false);
});

test('a recording that captured nothing writes nothing and is Empty', async () => {
	const memory = memoryFiles();
	const { folder } = browser({
		files: memory.files,
		Recorder: fakeRecorderClass(() => new Uint8Array()),
	});
	const recording = expectOk(
		await recorder.start({ folder, path: 'recordings/a' }),
	);
	expect(expectErr(await recording.stop()).name).toBe('Empty');
	expect(memory.held.size).toBe(0);
});

test('recovery cuts a file a closed tab left half-written, answers every unnamed recording no tab is writing with its length, and leaves one a tab is writing', async () => {
	const whole = new Uint8Array(
		await Bun.file(
			new URL('./fixtures/chromium.m4a', import.meta.url),
		).arrayBuffer(),
	);
	const cut = whole.slice(0, whole.length - 100);
	const memory = memoryFiles({
		'recordings/cut.m4a': cut,
		'recordings/writing.m4a': cut,
		'recordings/whole.m4a': whole,
		'recordings/a.md': new Uint8Array([1]),
		'recordings/old/cut.m4a': cut,
		'elsewhere/cut.m4a': cut,
	});
	const locks = memoryLocks();
	const { folder } = browser({ files: memory.files, locks });
	locks.held.add('epicenter-recording:recordings/writing');

	const unnamed = [
		'recordings/cut.m4a',
		'recordings/writing.m4a',
		'recordings/whole.m4a',
	];
	// With nothing unnamed, every recording has its record: nothing is read.
	expect(
		expectOk(
			await recorder.recover({ folder, under: 'recordings', unnamed: [] }),
		),
	).toEqual({ recovered: [], unplaced: [] });
	expect(memory.held.get('recordings/cut.m4a')).toEqual(cut);
	const { recovered, unplaced } = expectOk(
		await recorder.recover({ folder, under: 'recordings', unnamed }),
	);
	expect(unplaced).toEqual([]);
	const repaired = memory.held.get('recordings/cut.m4a')!;
	// Each answers how long its file plays, read from that file once
	// repaired; a whole one is answered as it is.
	expect(recovered).toEqual([
		{
			path: 'recordings/cut.m4a',
			durationMs: audioDurationMs(repaired, 'm4a') ?? null,
		},
		{
			path: 'recordings/whole.m4a',
			durationMs: audioDurationMs(whole, 'm4a') ?? null,
		},
	]);
	expect(recovered[0]?.durationMs).toBeGreaterThan(0);
	expect(repaired.length).toBeLessThan(cut.length);
	expect(repaired).toEqual(whole.slice(0, repaired.length));
	expect(memory.held.get('recordings/writing.m4a')).toEqual(cut);
	expect(memory.held.get('recordings/whole.m4a')).toEqual(whole);
	expect(memory.held.get('recordings/old/cut.m4a')).toEqual(cut);
	await settle();
	expect(locks.held).toEqual(
		new Set(['epicenter-recording:recordings/writing']),
	);
	// A second run repairs nothing more, and answers the same recordings.
	expect(
		expectOk(await recorder.recover({ folder, under: 'recordings', unnamed })),
	).toEqual({ recovered, unplaced: [] });
	expect(memory.held.get('recordings/cut.m4a')).toEqual(repaired);
});

test('a recording holds its lock while it records, so recovery passes it by', async () => {
	const locks = memoryLocks();
	const { folder } = browser({ locks });
	const recording = expectOk(
		await recorder.start({ folder, path: 'recordings/a' }),
	);
	expect(locks.held).toEqual(new Set(['epicenter-recording:recordings/a']));
	const again = expectErr(
		await recorder.start({ folder, path: 'recordings/a' }),
	);
	expect(again.name).toBe('Busy');
	expectOk(await recording.stop());
	await settle();
	expect(locks.held.size).toBe(0);
});

test('a recording held in the page answers its audio, as WebM where the browser records no AAC', async () => {
	const { tick } = browser();
	const recording = expectOk(await startPageRecording());

	tick();
	const stopped = expectOk(await recording.stop());
	expect(stopped).toEqual({
		bytes: new Uint8Array([1, 2, 3]),
		extension: 'webm',
		durationMs: 1_500,
	});
	expect(expectErr(await recording.stop()).name).toBe('NotRecording');
});

test('AAC in MP4 is asked for first, and held in the page as m4a', async () => {
	browser({
		Recorder: fakeRecorderClass(
			() => new Uint8Array([4, 5]),
			['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2'],
		),
	});
	const recording = expectOk(await startPageRecording());
	expect(expectOk(await recording.stop()).extension).toBe('m4a');
});

test('the file is named by the type the recorder reports, however it spells it', async () => {
	for (const [reported, extension] of [
		[' Video/MP4 ; codecs=mp4a.40.2', 'm4a'],
		['audio/webm', 'webm'],
		['', 'webm'],
	] as const) {
		const memory = memoryFiles();
		const { folder } = browser({
			files: memory.files,
			Recorder: fakeRecorderClass(
				() => new Uint8Array([1]),
				undefined,
				reported,
			),
		});
		const recording = expectOk(
			await recorder.start({ folder, path: 'recordings/a' }),
		);
		expect(await placedPath(recording)).toBe(`recordings/a.${extension}`);
		expect([...memory.held.keys()]).toEqual([`recordings/a.${extension}`]);

		browser({
			Recorder: fakeRecorderClass(
				() => new Uint8Array([1]),
				undefined,
				reported,
			),
		});
		const held = expectOk(await startPageRecording());
		expect(expectOk(await held.stop()).extension).toBe(extension);
	}
});

test('a recording whose file takes a type it did not ask for still holds its lock, so recovery passes it by', async () => {
	const memory = memoryFiles();
	const locks = memoryLocks();
	const { folder } = browser({
		files: memory.files,
		locks,
		// Asked for WebM, the browser records MP4.
		Recorder: fakeRecorderClass(
			() => new Uint8Array([9]),
			undefined,
			'audio/mp4',
		),
	});
	const recording = expectOk(
		await recorder.start({ folder, path: 'recordings/a' }),
	);
	recorders.at(-1)!.piece(new Uint8Array([1]));
	await settle();
	expect(memory.held.get('recordings/a.m4a')).toEqual(new Uint8Array([1]));
	expect(
		expectOk(
			await recorder.recover({
				folder,
				under: 'recordings',
				unnamed: ['recordings/a.m4a'],
			}),
		).recovered,
	).toEqual([]);
	expect(await placedPath(recording)).toBe('recordings/a.m4a');
	await settle();
	expect(
		expectOk(
			await recorder.recover({
				folder,
				under: 'recordings',
				unnamed: ['recordings/a.m4a'],
			}),
		).recovered,
	).toEqual([{ path: 'recordings/a.m4a', durationMs: null }]);
});

test('a chosen microphone is asked for exactly, and refused rather than replaced', async () => {
	const asked: MediaStreamConstraints[] = [];
	browser({
		async getUserMedia(constraints) {
			asked.push(constraints);
			throw Object.assign(new Error('gone'), {
				name: 'OverconstrainedError',
			});
		},
	});
	const input = { deviceId: 'usb-1', label: 'USB Mic' };
	const refused = expectErr(await startPageRecording({ input }));
	expect(refused).toMatchObject({ name: 'InputUnavailable', label: 'USB Mic' });
	expect(asked).toEqual([
		{ audio: { ...UNPROCESSED, deviceId: { exact: 'usb-1' } } },
	]);

	const other = fakeStream('built-in');
	browser({ getUserMedia: async () => other.stream });
	expect(expectErr(await startPageRecording({ input })).name).toBe(
		'InputUnavailable',
	);
	expect(other.track.stopped).toBe(true);
});

test('refused access and a missing default microphone are refusals of their own, for recording, enabling, and a meter', async () => {
	for (const [thrown, expected] of [
		['NotAllowedError', 'PermissionDenied'],
		['SecurityError', 'PermissionDenied'],
		['NotFoundError', 'NoInputDevice'],
		['NotReadableError', 'Failed'],
	] as const) {
		browser({
			async getUserMedia() {
				throw Object.assign(new Error('no'), { name: thrown });
			},
		});
		expect(expectErr(await startPageRecording()).name).toBe(expected);
		expect(expectErr(await recorder.allow()).name).toBe(expected);
		expect(expectErr(await recorder.openMeter()).name).toBe(expected);
	}
});

test('stop releases the microphone, and a second stop is NotRecording', async () => {
	const { stream, track } = fakeStream('default');
	browser({ getUserMedia: async () => stream });
	const recording = expectOk(await startPageRecording());
	await recording.stop();
	expect(track.stopped).toBe(true);
	expect(expectErr(await recording.stop()).name).toBe('NotRecording');
});

test('a start, a meter, or enabling withdrawn while the browser answers releases the late stream', async () => {
	for (const request of [
		(signal: AbortSignal) => startPageRecording({ signal }),
		(signal: AbortSignal) => recorder.openMeter({ signal }),
		(signal: AbortSignal) => recorder.allow({ signal }),
	]) {
		const { stream, track } = fakeStream('default');
		const controller = new AbortController();
		browser({
			async getUserMedia() {
				controller.abort();
				return stream;
			},
		});
		expect(expectErr(await request(controller.signal)).name).toBe('Cancelled');
		expect(track.stopped).toBe(true);
	}
});

test('an encoder that cannot be made, started, or stopped is a failure, and the microphone is released', async () => {
	const Base = fakeRecorderClass(() => new Uint8Array([1, 2, 3]));
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
		const { stream, track } = fakeStream('default');
		const memory = memoryFiles();
		const { folder } = browser({
			files: memory.files,
			getUserMedia: async () => stream,
			Recorder,
		});
		expect(
			expectErr(await recorder.start({ folder, path: 'recordings/a' })).name,
		).toBe('Failed');
		expect(track.stopped).toBe(true);
		expect(memory.held.size).toBe(0);
	}

	// One that will not stop never says it stopped: Stop answers anyway.
	const { stream, track } = fakeStream('default');
	browser({
		getUserMedia: async () => stream,
		Recorder: class extends Base {
			override stop(): void {
				throw new Error('InvalidStateError');
			}
		},
	});
	const recording = expectOk(await startPageRecording());
	expect(expectErr(await recording.stop()).name).toBe('Failed');
	expect(track.stopped).toBe(true);
});

test('audio the page cannot read is a failure, not a thrown stop, and the microphone is still released', async () => {
	const unreadable = new Error('NotReadableError');
	class UnreadableBlob extends Blob {
		override async arrayBuffer(): Promise<ArrayBuffer> {
			throw unreadable;
		}
	}

	// Held in the page: the whole recording is read at stop.
	const held = fakeStream('default');
	browser({ getUserMedia: async () => held.stream });
	const recording = expectOk(await startPageRecording());
	stub(globalThis, 'Blob', UnreadableBlob);
	expect(expectErr(await recording.stop())).toMatchObject({
		name: 'Failed',
		cause: unreadable,
	});
	expect(held.track.stopped).toBe(true);
	expect(expectErr(await recording.stop()).name).toBe('NotRecording');

	// Written as it records: a piece that cannot be read ends it there.
	const written = fakeStream('default');
	const memory = memoryFiles();
	const { folder } = browser({
		files: memory.files,
		getUserMedia: async () => written.stream,
	});
	const writing = expectOk(
		await recorder.start({ folder, path: 'recordings/a' }),
	);
	const endings: string[] = [];
	writing.onEnded((reason) => endings.push(reason));
	// Every piece is an unreadable Blob still.
	recorders.at(-1)!.piece(new Uint8Array([1]));
	await settle();
	expect(endings).toEqual(['streamFailed']);
	expect(expectErr(await writing.stop())).toMatchObject({
		name: 'Failed',
		cause: unreadable,
	});
	expect(written.track.stopped).toBe(true);
	expect(memory.held.size).toBe(0);
});

test('a recording held in the page that captured nothing is Empty', async () => {
	browser({ Recorder: fakeRecorderClass(() => new Uint8Array()) });
	const recording = expectOk(await startPageRecording());
	expect(expectErr(await recording.stop()).name).toBe('Empty');
});

test('a lost microphone ends a recording', async () => {
	const { stream, track } = fakeStream('default');
	browser({ getUserMedia: async () => stream });
	const recording = expectOk(await startPageRecording());
	const endings: string[] = [];
	recording.onEnded((reason) => endings.push(reason));
	track.end();
	expect(endings).toEqual(['deviceDisconnected']);
	expectOk(await recording.stop());
});

test('a window without a microphone, an encoder, or MP4 or WebM audio cannot record', async () => {
	for (const [target, key] of [
		[navigator, 'mediaDevices'],
		[globalThis, 'MediaRecorder'],
	] as const) {
		browser();
		stub(target, key, undefined);
		expect(expectErr(await startPageRecording()).name).toBe('Unavailable');
	}
	browser({ Recorder: fakeRecorderClass(() => new Uint8Array([1]), []) });
	expect(expectErr(await startPageRecording()).name).toBe('Unavailable');
});

test('an already-ended browser stream keeps its final bytes and reports the ending to a late subscriber', async () => {
	const { stream, track } = fakeStream('default');
	browser({ getUserMedia: async () => stream });
	const recording = expectOk(await startPageRecording());
	track.end();
	await Promise.resolve();
	const endings: string[] = [];
	recording.onEnded((reason) => endings.push(reason));
	expect(endings).toEqual(['deviceDisconnected']);
	expect(expectOk(await recording.stop()).bytes).toEqual(
		new Uint8Array([1, 2, 3]),
	);
	const late: string[] = [];
	recording.onEnded((reason) => late.push(reason));
	track.end();
	expect(late).toEqual([]);
});

test('an ending reaches every listener when the first listener stops the browser recorder', async () => {
	const { stream, track } = fakeStream('default');
	browser({ getUserMedia: async () => stream });
	const recording = expectOk(await startPageRecording());
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
