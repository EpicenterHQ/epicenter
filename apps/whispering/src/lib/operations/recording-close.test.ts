/** Verifies capture disposal, late acquisition rollback, and recording publication. */
import { expect, mock, test } from 'bun:test';
import type { Recording, RecordingService } from '@epicenter/app/recorder';
import { generateBlobId } from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import type { WhisperingApp } from '$lib/whispering/app';
import { createPendingSaves } from '../whispering/pending-saves.js';

Reflect.set(
	globalThis,
	'$state',
	Object.assign(<T>(value: T) => value, { raw: <T>(value: T) => value }),
);
const finalized = Promise.withResolvers<void>();
let initialized = Promise.withResolvers<void>();
const events: string[] = [];
let pipelineFailure: Error | undefined;
let vadFailure: Error | undefined;
const capture = {
	id: crypto.randomUUID(),
	device: { outcome: 'success' },
	onEnded: () => () => {},
	onLevel: () => () => {},
	state: 'IDLE',
	isStarting: false,
	async stop() {
		events.push('finalize');
		await finalized.promise;
		return Ok({
			blobId: generateBlobId('wav'),
			durationMs: 100,
			byteLength: 10,
		});
	},
	cancel: async () => Ok(undefined),
};
let speechEnd: ((blob: Blob) => Promise<void>) | undefined;
const vadRecorder = {
	state: 'IDLE',
	async stopActiveListening() {
		if (vadFailure) throw vadFailure;
		vadRecorder.state = 'IDLE';
		events.push('vad released');
		return Ok({ status: 'stopped' });
	},
	async startActiveListening(options: {
		onSpeechEnd(blob: Blob): Promise<void>;
	}) {
		speechEnd = options.onSpeechEnd;
		events.push('initialize');
		await initialized.promise;
		vadRecorder.state = 'LISTENING';
		return Ok({ outcome: 'success' });
	},
};
mock.module('../state/vad-recorder.svelte', () => ({ vadRecorder }));
mock.module('$lib/state/vad-recorder.svelte', () => ({ vadRecorder }));
mock.module('#platform/manual-recorder-config', () => ({
	manualRecorderConfig: { resolveStartParams: () => ({}) },
}));
mock.module('#platform/recording-mic-level', () => ({
	reportRecordingMicLevel: mock(),
}));
mock.module('$app/navigation', () => ({ goto: mock() }));
mock.module('$app/paths', () => ({ resolve: (path: string) => path }));
mock.module('$lib/operations/analytics', () => ({ logAnalyticsEvent: mock() }));
mock.module('$lib/operations/media', () => ({
	recordingMedia: { resume: mock(), pause: mock() },
}));
mock.module('$lib/operations/pipeline', () => ({
	processRecordingPipeline: async () => {
		if (pipelineFailure) throw pipelineFailure;
	},
}));
mock.module('$lib/operations/transcribe', () => ({
	captureTranscription: () => async () => Ok('captured'),
}));
mock.module('$lib/operations/sound', () => ({ playSoundIfEnabled: mock() }));
mock.module('$lib/report', () => ({ report: { info: mock(), error: mock() } }));
mock.module('$lib/state/capture-surface.svelte', () => ({
	captureSurface: { dismissImport: mock() },
}));
mock.module('$lib/state/device-config.svelte', () => ({
	deviceConfig: { set: mock() },
}));
mock.module('$lib/state/dictation-lifecycle.svelte', () => ({
	dictationLifecycle: { reset: mock(() => () => true), markFailed: mock() },
}));
const {
	createWhisperingRecording,
	startVadRecording,
	cancelRecording,
	stopVadRecording,
	disposeVadRecording,
} = await import('./recording.svelte.js');

function recordingApp<T extends object>(
	options: T,
	service = {
		start: async () => Ok(capture as unknown as Recording),
		current: async () => Ok(null),
		enumerateDevices: async () => Ok([]),
	} as RecordingService,
) {
	let savedRow: Record<string, unknown> | undefined;
	const app = {
		signal: new AbortController().signal,
		local: { kv: { update: mock() } },
		store: {
			tables: {
				recordings: {
					get: () => savedRow,
					create: (values: Record<string, unknown>) => {
						events.push('save');
						savedRow = { ...values, id: 'original-row' };
						return savedRow;
					},
				},
			},
		},
		...options,
	} as unknown as T & WhisperingApp;
	app.pendingSaves = createPendingSaves(app.signal);
	mock.module('../whispering/local.js', () => ({
		local: {
			...Reflect.get(app, 'local'),
			...Reflect.get(app, 'store'),
			blobs: Reflect.get(app, 'localBlobs'),
			persistence: { flush: async () => {}, get: () => 'saved' },
		},
	}));
	const session = createWhisperingRecording(app, service);
	Object.defineProperty(app, 'recording', { value: session.recording });
	return app;
}

test('ordinary native finalization publishes its saved recording', async () => {
	const app = recordingApp({
		account: undefined,
		recordingEnabled: true,
	});
	await app.recording.start();
	const stopping = app.recording.stop();
	await Bun.sleep(0);
	expect(events).toEqual(['finalize']);
	app.recordingEnabled = false;
	expect(app.signal.aborted).toBe(false);
	finalized.resolve();
	await Bun.sleep(0);
	expect(events).toEqual(['finalize', 'save']);
	await stopping;
	expect(events.at(-1)).toBe('save');
});

test('disposal releases an armed VAD engine without waiting for save work', async () => {
	vadRecorder.state = 'LISTENING';
	await disposeVadRecording();
	expect(vadRecorder.state).toBe('IDLE');
	expect(events.at(-1)).toBe('vad released');
});

test('VAD acquired after disposal is immediately released', async () => {
	const app = recordingApp({
		recordingEnabled: true,
		local: { kv: { update: mock() } },
	});
	initialized = Promise.withResolvers<void>();
	const starting = startVadRecording(app);
	expect(vadRecorder.state).toBe('IDLE');
	app.recordingEnabled = false;
	initialized.resolve();
	await starting;
	expect(vadRecorder.state).toBe('IDLE');
	expect(events.at(-1)).toBe('vad released');
});

test('queued capture actions cannot restart a disposed UI session', async () => {
	const app = recordingApp({ recordingEnabled: false });
	const before = events.length;
	expect(await app.recording.start()).toBeNull();
	await startVadRecording(app);
	await app.recording.stop();
	await cancelRecording(app);
	await stopVadRecording(app);
	expect(events).toHaveLength(before);
});

test('a late VAD frame cannot save through its retired App', async () => {
	const app = recordingApp({
		recordingEnabled: true,
		local: { kv: { update: mock() } },
	});
	await startVadRecording(app as unknown as WhisperingApp);
	app.recordingEnabled = false;
	const before = events.length;
	await speechEnd?.(new Blob(['late frame']));
	expect(events).toHaveLength(before);
});

test('a pipeline failure follows recording publication', async () => {
	finalized.resolve();
	const before = events.length;
	const app = recordingApp({
		recordingEnabled: true,
	});
	pipelineFailure = new Error('Post-save pipeline failed');
	try {
		await app.recording.start();
		await expect(app.recording.stop()).rejects.toBe(pipelineFailure);
		expect(events.slice(before)).toEqual(['finalize', 'save']);
	} finally {
		pipelineFailure = undefined;
	}
});

test('completed saving publishes the recording', async () => {
	finalized.resolve();
	const before = events.length;
	const app = recordingApp({
		recordingEnabled: true,
	});
	await app.recording.start();
	await app.recording.stop();
	expect(events.slice(before)).toEqual(['finalize', 'save']);
});

test('a stale push-to-talk ID cannot stop the current recording', async () => {
	const app = recordingApp({ recordingEnabled: true });
	await app.recording.start();
	const before = events.length;
	await app.recording.stop(generateBlobId('wav'));
	expect(events).toHaveLength(before);
	expect(app.recording.state).toBe('RECORDING');
	await app.recording.stop(capture.id);
	expect(events.at(-1)).toBe('save');
});

test('push-to-talk release during startup saves through the composed workflow', async () => {
	const { pushToTalk } = await import('./push-to-talk');
	const acquired = Promise.withResolvers<ReturnType<typeof Ok<Recording>>>();
	const service = {
		enumerateDevices: async () => Ok([]),
		current: async () => Ok(null),
		start: () => acquired.promise,
	} as RecordingService;
	const app = recordingApp(
		{
			recordingEnabled: true,
			local: { kv: { update: mock() } },
		},
		service,
	);
	const starting = pushToTalk.start(app);
	expect(app.recording.isStarting).toBe(true);
	await pushToTalk.stop(app);
	acquired.resolve(
		Ok({
			...capture,
			onLevel: () => () => {},
			device: { outcome: 'success' },
		} as unknown as Recording),
	);
	await starting;
	expect(app.recording.state).toBe('IDLE');
	expect(events.at(-1)).toBe('save');
});

test('disposal cancels active capture without finalizing a recording', async () => {
	const cancel = mock(async () => Ok(undefined));
	const stop = mock(async () => {
		throw new Error('Must not save on disposal');
	});
	const app = {
		signal: new AbortController().signal,
		recordingEnabled: true,
		local: { kv: { update: mock() } },
		store: { tables: { recordings: {} } },
	} as unknown as WhisperingApp;
	app.pendingSaves = createPendingSaves(app.signal);
	mock.module('../whispering/local.js', () => ({
		local: Reflect.get(app, 'local'),
	}));
	const session = createWhisperingRecording(app, {
		start: async () => Ok({ ...capture, cancel, stop } as unknown as Recording),
		current: async () => Ok(null),
		enumerateDevices: async () => Ok([]),
	} as RecordingService);
	await session.recording.start();
	session[Symbol.dispose]();
	await Bun.sleep(0);
	expect(cancel).toHaveBeenCalledTimes(1);
	expect(stop).not.toHaveBeenCalled();
});

test('capture acquired after disposal is cancelled without publishing a row', async () => {
	const acquired = Promise.withResolvers<ReturnType<typeof Ok<Recording>>>();
	const cancel = mock(async () => Ok(undefined));
	const create = mock();
	const app = {
		signal: new AbortController().signal,
		recordingEnabled: true,
		local: { kv: { update: mock() } },
		store: { tables: { recordings: { create } } },
	} as unknown as WhisperingApp;
	app.pendingSaves = createPendingSaves(app.signal);
	mock.module('../whispering/local.js', () => ({
		local: Reflect.get(app, 'local'),
	}));
	const session = createWhisperingRecording(app, {
		start: () => acquired.promise,
		current: async () => Ok(null),
		enumerateDevices: async () => Ok([]),
	} as RecordingService);
	const starting = session.recording.start();
	session[Symbol.dispose]();
	acquired.resolve(Ok({ ...capture, cancel } as unknown as Recording));
	expect(await starting).toBeNull();
	expect(cancel).toHaveBeenCalledTimes(1);
	expect(create).not.toHaveBeenCalled();
});

test('VAD disposal reports release failure', async () => {
	vadFailure = new Error('Microphone graph still held');
	vadRecorder.state = 'LISTENING';
	try {
		await expect(disposeVadRecording()).rejects.toBe(vadFailure);
	} finally {
		vadFailure = undefined;
		await disposeVadRecording();
	}
});
