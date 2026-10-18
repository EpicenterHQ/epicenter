/**
 * The browser recorder over fakes of the browser's microphone, encoder, and
 * audio graph, writing into a fake folder.
 *
 * Key behaviors:
 * - A recording is written to the folder once, on stop, under its path plus
 *   the container's extension
 * - A chosen microphone that cannot be opened exactly is refused, never
 *   replaced, and anything opened is released
 * - Cancel writes nothing and releases the microphone; a second stop or
 *   cancel is `NotRecording`
 * - A start withdrawn while the browser answers releases what arrives late
 * - Levels are heard while recording, and recovery has nothing to repair
 */
import { expect, test } from 'bun:test';
import { Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type BrowserEnvironment, createBrowserRecorder } from './browser.js';
import type { RecordingFolder } from './recording.js';

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

/** A MediaRecorder that produces `produced` when it stops. */
function fakeRecorderClass(produced: () => Uint8Array) {
	return class FakeRecorder {
		static isTypeSupported(type: string) {
			return type === 'audio/webm;codecs=opus';
		}
		readonly mimeType: string;
		readonly listeners = new Map<string, ((event: unknown) => void)[]>();
		constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
			this.mimeType = options?.mimeType ?? '';
		}
		addEventListener(type: string, listener: (event: unknown) => void) {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
		}
		start() {}
		stop() {
			const bytes = produced();
			for (const listener of this.listeners.get('dataavailable') ?? [])
				listener({ data: new Blob([bytes as BlobPart]) });
			for (const listener of this.listeners.get('stop') ?? []) listener({});
		}
	} as unknown as BrowserEnvironment['Recorder'];
}

function fakeFolder(refuse?: string) {
	const written: { path: string; bytes: Uint8Array }[] = [];
	const folder: RecordingFolder = {
		id: 'so.epicenter.test',
		async write(path, _from, bytes) {
			if (refuse !== undefined)
				return { data: null, error: { message: refuse } } as Result<
					unknown,
					{ message: string }
				>;
			written.push({ path, bytes });
			return Ok(undefined);
		},
	};
	return { folder, written };
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

test('a recording is written to the folder once, on stop, with its container extension', async () => {
	const { folder, written } = fakeFolder();
	const { startRecording } = createBrowserRecorder(environment());
	const recording = expectOk(
		await startRecording({ folder, path: 'recordings/2026-10-15-0930' }),
	);
	expect(recording.path).toBe('recordings/2026-10-15-0930.webm');
	expect(recording.device).toBe('Desk Microphone');
	expect(written).toEqual([]);

	const stopped = expectOk(await recording.stop());
	expect(stopped).toEqual({
		path: 'recordings/2026-10-15-0930.webm',
		durationMs: 1_500,
	});
	expect(written).toEqual([
		{
			path: 'recordings/2026-10-15-0930.webm',
			bytes: new Uint8Array([1, 2, 3]),
		},
	]);
	expect(expectErr(await recording.stop()).name).toBe('NotRecording');
});

test('a chosen microphone is asked for exactly, and refused rather than replaced', async () => {
	const { folder } = fakeFolder();
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
		await overconstrained.startRecording({ folder, path: 'a', input }),
	);
	expect(refused).toMatchObject({ name: 'InputUnavailable', label: 'USB Mic' });
	expect(asked).toEqual([{ audio: { deviceId: { exact: 'usb-1' } } }]);

	const other = fakeStream('built-in');
	const substituted = createBrowserRecorder(
		environment({ getUserMedia: async () => other.stream }),
	);
	expect(
		expectErr(await substituted.startRecording({ folder, path: 'a', input }))
			.name,
	).toBe('InputUnavailable');
	expect(other.track.stopped).toBe(true);
});

test('a denied permission is its own refusal', async () => {
	const { folder } = fakeFolder();
	const { startRecording } = createBrowserRecorder(
		environment({
			async getUserMedia() {
				throw Object.assign(new Error('no'), { name: 'NotAllowedError' });
			},
		}),
	);
	expect(expectErr(await startRecording({ folder, path: 'a' })).name).toBe(
		'PermissionDenied',
	);
});

test('cancel writes nothing and releases the microphone', async () => {
	const { folder, written } = fakeFolder();
	const { stream, track } = fakeStream('default');
	const { startRecording } = createBrowserRecorder(
		environment({ getUserMedia: async () => stream }),
	);
	const recording = expectOk(await startRecording({ folder, path: 'a' }));
	expectOk(await recording.cancel());
	expect(track.stopped).toBe(true);
	expect(written).toEqual([]);
	expect(expectErr(await recording.cancel()).name).toBe('NotRecording');
	expect(expectErr(await recording.stop()).name).toBe('NotRecording');
});

test('a start withdrawn while the browser answers releases the late stream', async () => {
	const { folder } = fakeFolder();
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
		expectErr(
			await startRecording({ folder, path: 'a', signal: controller.signal }),
		).name,
	).toBe('Cancelled');
	expect(track.stopped).toBe(true);
});

test('a recording that captured nothing writes no file', async () => {
	const { folder, written } = fakeFolder();
	const { startRecording } = createBrowserRecorder(
		environment({ Recorder: fakeRecorderClass(() => new Uint8Array()) }),
	);
	const recording = expectOk(await startRecording({ folder, path: 'a' }));
	expect(expectErr(await recording.stop()).name).toBe('Empty');
	expect(written).toEqual([]);
});

test('a folder that refuses the file is a refusal, not a saved recording', async () => {
	const { folder } = fakeFolder('a file is already at a.webm');
	const { startRecording } = createBrowserRecorder(environment());
	const recording = expectOk(await startRecording({ folder, path: 'a' }));
	expect(expectErr(await recording.stop())).toMatchObject({
		name: 'Refused',
		reason: 'a file is already at a.webm',
	});
});

test('levels are heard while recording, and a lost microphone is an ending', async () => {
	const { folder } = fakeFolder();
	const { stream, track } = fakeStream('default');
	const { startRecording } = createBrowserRecorder(
		environment({ getUserMedia: async () => stream }),
	);
	const recording = expectOk(await startRecording({ folder, path: 'a' }));
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
	const { folder } = fakeFolder();
	for (const missing of [
		{ mediaDevices: undefined },
		{ Recorder: undefined },
	]) {
		const { startRecording } = createBrowserRecorder(environment(missing));
		expect(expectErr(await startRecording({ folder, path: 'a' })).name).toBe(
			'Unavailable',
		);
	}
});

test('a browser has no cut-off recordings to repair', async () => {
	const { folder } = fakeFolder();
	const { recoverRecordings } = createBrowserRecorder(environment());
	expect(
		expectOk(await recoverRecordings({ folder, under: 'recordings' })),
	).toEqual([]);
});
