/**
 * The browser recorder over fakes of the browser's microphone, encoder,
 * audio graph, files, and locks.
 *
 * Key behaviors:
 * - A recording is written into the store as it records: the first piece
 *   makes `<path>.<ext>`, each later one is appended the moment it arrives,
 *   and the store's listeners hear the file made and finished, not each piece
 * - A store that keeps no files here, or a file already at the path, is
 *   refused before any microphone opens
 * - A store that stops taking pieces ends the recording (`storageFailed`),
 *   keeping what landed
 * - Recovery cuts a file a closed tab left half-written back to its last
 *   whole piece, and leaves a recording another tab is writing alone
 * - A recording held in the page answers its audio at stop, named by the
 *   type the browser produced: AAC in MP4 (`m4a`), else Opus in WebM (`webm`)
 * - A chosen microphone that cannot be opened exactly is refused, never
 *   replaced, and anything opened is released
 * - Stop releases the microphone; a second stop is `NotRecording`
 * - A start withdrawn while the browser answers releases what arrives late
 * - Levels are heard while recording
 */
import { expect, test } from 'bun:test';
import type { DeviceFiles } from '@epicenter/folder/browser';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type BrowserEnvironment,
	containerOf,
	createBrowserRecorder,
} from './browser.js';

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

/** A MediaRecorder that records the `supported` types and produces `produced` when it stops. */
function fakeRecorderClass(
	produced: () => Uint8Array,
	supported: readonly string[] = ['audio/webm;codecs=opus'],
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
			this.mimeType = options?.mimeType ?? '';
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
	} as unknown as BrowserEnvironment['Recorder'];
}

function environment(
	overrides: Partial<BrowserEnvironment> & {
		getUserMedia?: (
			constraints: MediaStreamConstraints,
		) => Promise<MediaStream>;
	} = {},
): BrowserEnvironment {
	let clock = 1_000;
	const { stream } = fakeStream('default');
	return {
		mediaDevices: {
			getUserMedia: overrides.getUserMedia ?? (async () => stream),
		},
		Recorder: fakeRecorderClass(() => new Uint8Array([1, 2, 3])),
		createLevelContext: () => ({
			createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
			createAnalyser: () => ({
				fftSize: 0,
				getFloatTimeDomainData(samples: Float32Array) {
					samples.fill(0.5);
				},
			}),
			resume: async () => {},
			close: async () => {},
		}),
		now: () => {
			clock += 1_500;
			return clock;
		},
		filesOf: () => memoryFiles().files,
		locks: undefined,
		...overrides,
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
			if (there === undefined || versionOf(there) !== expected)
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

const store = {} as Parameters<
	ReturnType<typeof createBrowserRecorder>['startRecording']
>[0]['device'];

/** Let queued appends land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a recording is written into the store as it records, and heard made and finished', async () => {
	const memory = memoryFiles();
	const { startRecording } = createBrowserRecorder(
		environment({
			filesOf: () => memory.files,
			Recorder: fakeRecorderClass(() => new Uint8Array([9])),
		}),
	);
	const recording = expectOk(
		await startRecording({ device: store, path: 'recordings/a' }),
	);
	expect(recording.path).toBe('recordings/a.webm');
	expect(recording.microphone).toBe('Desk Microphone');
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

test('AAC in MP4 is recorded into <path>.m4a where the browser records it', async () => {
	const memory = memoryFiles();
	const { startRecording } = createBrowserRecorder(
		environment({
			filesOf: () => memory.files,
			Recorder: fakeRecorderClass(
				() => new Uint8Array([4, 5]),
				['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2'],
			),
		}),
	);
	const recording = expectOk(
		await startRecording({ device: store, path: 'recordings/a' }),
	);
	expect(recording.path).toBe('recordings/a.m4a');
	expectOk(await recording.stop());
	expect(memory.held.get('recordings/a.m4a')).toEqual(new Uint8Array([4, 5]));
});

test('a store that keeps no files here, or a file at the path, is refused before the microphone opens', async () => {
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
		await createBrowserRecorder(
			environment({ filesOf: () => privateWindow.files, getUserMedia }),
		).startRecording({ device: store, path: 'recordings/a' }),
	);
	expect(refused).toMatchObject({
		name: 'Refused',
		reason: 'This browser gives the page no private file storage',
	});

	const taken = memoryFiles({ 'recordings/a.webm': new Uint8Array([7]) });
	const occupied = expectErr(
		await createBrowserRecorder(
			environment({ filesOf: () => taken.files, getUserMedia }),
		).startRecording({ device: store, path: 'recordings/a' }),
	);
	expect(occupied.name).toBe('Refused');
	expect(taken.held.get('recordings/a.webm')).toEqual(new Uint8Array([7]));
	expect(opened).toBe(0);
});

test('a store that stops taking pieces ends the recording, and stop keeps what landed', async () => {
	const memory = memoryFiles();
	const { startRecording } = createBrowserRecorder(
		environment({
			filesOf: () => memory.files,
			Recorder: fakeRecorderClass(() => new Uint8Array([9])),
		}),
	);
	const recording = expectOk(
		await startRecording({ device: store, path: 'recordings/a' }),
	);
	const endings: string[] = [];
	recording.onEnded((reason) => endings.push(reason));
	recorders.at(-1)!.piece(new Uint8Array([1]));
	await settle();
	memory.held.delete('recordings/a.webm');
	recorders.at(-1)!.piece(new Uint8Array([2]));
	await settle();
	expect(endings).toEqual(['storageFailed']);
	expect(expectOk(await recording.stop()).path).toBe('recordings/a.webm');
	expect(memory.held.has('recordings/a.webm')).toBe(false);
});

test('a recording that captured nothing writes nothing and is Empty', async () => {
	const memory = memoryFiles();
	const { startRecording } = createBrowserRecorder(
		environment({
			filesOf: () => memory.files,
			Recorder: fakeRecorderClass(() => new Uint8Array()),
		}),
	);
	const recording = expectOk(
		await startRecording({ device: store, path: 'recordings/a' }),
	);
	expect(expectErr(await recording.stop()).name).toBe('Empty');
	expect(memory.held.size).toBe(0);
});

test('recovery cuts a file a closed tab left half-written, and leaves one a tab is writing', async () => {
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
	const { recoverRecordings } = createBrowserRecorder(
		environment({ filesOf: () => memory.files, locks }),
	);
	locks.held.add('epicenter-recording:recordings/writing.m4a');

	expect(
		expectOk(await recoverRecordings({ device: store, under: 'recordings' })),
	).toEqual(['recordings/cut.m4a']);
	const repaired = memory.held.get('recordings/cut.m4a')!;
	expect(repaired.length).toBeLessThan(cut.length);
	expect(repaired).toEqual(whole.slice(0, repaired.length));
	expect(memory.held.get('recordings/writing.m4a')).toEqual(cut);
	expect(memory.held.get('recordings/whole.m4a')).toEqual(whole);
	expect(memory.held.get('recordings/old/cut.m4a')).toEqual(cut);
	await settle();
	expect(locks.held).toEqual(
		new Set(['epicenter-recording:recordings/writing.m4a']),
	);
	expect(
		expectOk(await recoverRecordings({ device: store, under: 'recordings' })),
	).toEqual([]);
});

test('a recording holds its lock while it records, so recovery passes it by', async () => {
	const memory = memoryFiles();
	const locks = memoryLocks();
	const { startRecording } = createBrowserRecorder(
		environment({ filesOf: () => memory.files, locks }),
	);
	const recording = expectOk(
		await startRecording({ device: store, path: 'recordings/a' }),
	);
	expect(locks.held).toEqual(
		new Set(['epicenter-recording:recordings/a.webm']),
	);
	const again = expectErr(
		await startRecording({ device: store, path: 'recordings/a' }),
	);
	expect(again.name).toBe('Busy');
	expectOk(await recording.stop());
	await settle();
	expect(locks.held.size).toBe(0);
});

test('a recording held in the page answers its audio, as WebM where the browser records no AAC', async () => {
	const { startPageRecording: startRecording } = createBrowserRecorder(
		environment(),
	);
	const recording = expectOk(await startRecording());
	expect(recording.microphone).toBe('Desk Microphone');

	const stopped = expectOk(await recording.stop());
	expect(stopped).toEqual({
		bytes: new Uint8Array([1, 2, 3]),
		extension: 'webm',
		mimeType: 'audio/webm',
		durationMs: 1_500,
	});
	expect(expectErr(await recording.stop()).name).toBe('NotRecording');
});

test('AAC in MP4 is asked for first, and held in the page as m4a', async () => {
	const { startPageRecording: startRecording } = createBrowserRecorder(
		environment({
			Recorder: fakeRecorderClass(
				() => new Uint8Array([4, 5]),
				['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2'],
			),
		}),
	);
	const recording = expectOk(await startRecording());
	expect(expectOk(await recording.stop())).toMatchObject({
		extension: 'm4a',
		mimeType: 'audio/mp4',
	});
});

test('the extension follows the type produced, however the engine spells it', () => {
	expect(containerOf('audio/mp4; codecs=mp4a.40.2')).toEqual({
		extension: 'm4a',
		mimeType: 'audio/mp4',
	});
	expect(containerOf('audio/webm;codecs=opus').extension).toBe('webm');
	expect(containerOf('audio/ogg;codecs=opus').extension).toBe('ogg');
	expect(containerOf('').extension).toBe('webm');
});

test('a chosen microphone is asked for exactly, and refused rather than replaced', async () => {
	const asked: MediaStreamConstraints[] = [];
	const overconstrained = createBrowserRecorder(
		environment({
			async getUserMedia(constraints) {
				asked.push(constraints);
				throw Object.assign(new Error('gone'), {
					name: 'OverconstrainedError',
				});
			},
		}),
	);
	const input = { deviceId: 'usb-1', label: 'USB Mic' };
	const refused = expectErr(
		await overconstrained.startPageRecording({ input }),
	);
	expect(refused).toMatchObject({ name: 'InputUnavailable', label: 'USB Mic' });
	expect(asked).toEqual([{ audio: { deviceId: { exact: 'usb-1' } } }]);

	const other = fakeStream('built-in');
	const substituted = createBrowserRecorder(
		environment({ getUserMedia: async () => other.stream }),
	);
	expect(expectErr(await substituted.startPageRecording({ input })).name).toBe(
		'InputUnavailable',
	);
	expect(other.track.stopped).toBe(true);
});

test('a denied permission is its own refusal', async () => {
	const { startPageRecording: startRecording } = createBrowserRecorder(
		environment({
			async getUserMedia() {
				throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
			},
		}),
	);
	expect(expectErr(await startRecording()).name).toBe('PermissionDenied');
});

test('stop releases the microphone, and a second stop is NotRecording', async () => {
	const { stream, track } = fakeStream('default');
	const { startPageRecording: startRecording } = createBrowserRecorder(
		environment({ getUserMedia: async () => stream }),
	);
	const recording = expectOk(await startRecording());
	await recording.stop();
	expect(track.stopped).toBe(true);
	expect(expectErr(await recording.stop()).name).toBe('NotRecording');
});

test('a start withdrawn while the browser answers releases the late stream', async () => {
	const { stream, track } = fakeStream('default');
	const controller = new AbortController();
	const { startPageRecording: startRecording } = createBrowserRecorder(
		environment({
			async getUserMedia() {
				controller.abort();
				return stream;
			},
		}),
	);
	expect(
		expectErr(await startRecording({ signal: controller.signal })).name,
	).toBe('Cancelled');
	expect(track.stopped).toBe(true);
});

test('a recording held in the page that captured nothing is Empty', async () => {
	const { startPageRecording: startRecording } = createBrowserRecorder(
		environment({ Recorder: fakeRecorderClass(() => new Uint8Array()) }),
	);
	const recording = expectOk(await startRecording());
	expect(expectErr(await recording.stop()).name).toBe('Empty');
});

test('levels are heard while recording, and a lost microphone is an ending', async () => {
	const { stream, track } = fakeStream('default');
	const { startPageRecording: startRecording } = createBrowserRecorder(
		environment({ getUserMedia: async () => stream }),
	);
	const recording = expectOk(await startRecording());
	const levels: number[] = [];
	const endings: string[] = [];
	recording.onLevel((level) => levels.push(level));
	recording.onEnded((reason) => endings.push(reason));
	await new Promise((resolve) => setTimeout(resolve, 120));
	expect(levels.length).toBeGreaterThan(0);
	expect(levels[0]).toBeCloseTo(0.5);
	track.end();
	expect(endings).toEqual(['deviceDisconnected']);
	expectOk(await recording.stop());
	const heard = levels.length;
	await new Promise((resolve) => setTimeout(resolve, 120));
	expect(levels.length).toBe(heard);
});

test('a window without a microphone or an encoder cannot record', async () => {
	for (const missing of [
		{ mediaDevices: undefined },
		{ Recorder: undefined },
	]) {
		const { startPageRecording: startRecording } = createBrowserRecorder(
			environment(missing),
		);
		expect(expectErr(await startRecording()).name).toBe('Unavailable');
	}
});

test('an already-ended browser stream keeps its final bytes and reports the ending to a late subscriber', async () => {
	const { stream, track } = fakeStream('default');
	const { startPageRecording: startRecording } = createBrowserRecorder(
		environment({ getUserMedia: async () => stream }),
	);
	const recording = expectOk(await startRecording());
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
	const { startPageRecording: startRecording } = createBrowserRecorder(
		environment({ getUserMedia: async () => stream }),
	);
	const recording = expectOk(await startRecording());
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
