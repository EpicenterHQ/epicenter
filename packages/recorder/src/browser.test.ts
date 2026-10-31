/**
 * The browser recorder over fakes of the browser's microphone, encoder, and
 * audio graph.
 *
 * Key behaviors:
 * - Stop answers the audio, named by the type the browser produced: AAC in
 *   MP4 (`m4a`) when the browser records it, else Opus in WebM (`webm`)
 * - A chosen microphone that cannot be opened exactly is refused, never
 *   replaced, and anything opened is released
 * - Stop releases the microphone; a second stop is `NotRecording`
 * - A start withdrawn while the browser answers releases what arrives late
 * - Levels are heard while recording
 */
import { expect, test } from 'bun:test';
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
				listener({ data: new Blob([bytes as BlobPart]) });
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
		...overrides,
	};
}

test('stop answers the audio, as WebM where the browser records no AAC', async () => {
	const { startRecording } = createBrowserRecorder(environment());
	const recording = expectOk(await startRecording());
	expect(recording.device).toBe('Desk Microphone');

	const stopped = expectOk(await recording.stop());
	expect(stopped).toEqual({
		bytes: new Uint8Array([1, 2, 3]),
		extension: 'webm',
		mimeType: 'audio/webm',
		durationMs: 1_500,
	});
	expect(expectErr(await recording.stop()).name).toBe('NotRecording');
});

test('AAC in MP4 is asked for first, and saved as m4a', async () => {
	const { startRecording } = createBrowserRecorder(
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
	const refused = expectErr(await overconstrained.startRecording({ input }));
	expect(refused).toMatchObject({ name: 'InputUnavailable', label: 'USB Mic' });
	expect(asked).toEqual([{ audio: { deviceId: { exact: 'usb-1' } } }]);

	const other = fakeStream('built-in');
	const substituted = createBrowserRecorder(
		environment({ getUserMedia: async () => other.stream }),
	);
	expect(expectErr(await substituted.startRecording({ input })).name).toBe(
		'InputUnavailable',
	);
	expect(other.track.stopped).toBe(true);
});

test('a denied permission is its own refusal', async () => {
	const { startRecording } = createBrowserRecorder(
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
	const { startRecording } = createBrowserRecorder(
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
	const { startRecording } = createBrowserRecorder(
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

test('a recording that captured nothing is Empty', async () => {
	const { startRecording } = createBrowserRecorder(
		environment({ Recorder: fakeRecorderClass(() => new Uint8Array()) }),
	);
	const recording = expectOk(await startRecording());
	expect(expectErr(await recording.stop()).name).toBe('Empty');
});

test('levels are heard while recording, and a lost microphone is an ending', async () => {
	const { stream, track } = fakeStream('default');
	const { startRecording } = createBrowserRecorder(
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
		const { startRecording } = createBrowserRecorder(environment(missing));
		expect(expectErr(await startRecording()).name).toBe('Unavailable');
	}
});

test('an already-ended browser stream keeps its final bytes and reports the ending to a late subscriber', async () => {
	const { stream, track } = fakeStream('default');
	const { startRecording } = createBrowserRecorder(
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
	const { startRecording } = createBrowserRecorder(
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
