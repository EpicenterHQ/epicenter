/** Verifies capture work blocks closure and failed saving preserves source audio. */
import { expect, mock, test } from 'bun:test';
import type { Recording, RecordingService } from '@epicenter/app/recorder';
import { createInferenceSelections } from '@epicenter/app-shell/inference-selections';
import { generateBlobId } from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import type { WhisperingApp } from '$lib/whispering/app';

Reflect.set(
	globalThis,
	'$state',
	Object.assign(<T>(value: T) => value, { raw: <T>(value: T) => value }),
);
const finalized = Promise.withResolvers<void>();
const saved = Promise.withResolvers<void>();
const initialized = Promise.withResolvers<void>();
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
			file: new Blob(['audio'], { type: 'audio/wav' }),
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
const activity = await import('../state/recording-active.svelte');
const { recordingActive } = activity;
mock.module('$lib/state/recording-active.svelte', () => activity);
const {
	createWhisperingRecording,
	startVadRecording,
	cancelRecording,
	stopVadRecording,
	closeRecordingWork,
} = await import('./recording.svelte.js');

function recordingApp<T extends object>(
	options: T,
	service = {
		start: async () => Ok(capture as unknown as Recording),
		discard: async () => Ok(undefined),
		current: async () => Ok(null),
		enumerateDevices: async () => Ok([]),
	} as RecordingService,
) {
	const app = {
		signal: new AbortController().signal,
		settings: { set: mock() },
		recordings: {
			get: () => ({ id: 'original-row' }),
			patch: mock(),
			create: async () => {
				events.push('save');
				await saved.promise;
				return Ok({ id: 'original-row' });
			},
		},
		...options,
	} as T & WhisperingApp;
	const session = createWhisperingRecording(app, service);
	Object.defineProperty(app, 'recording', { value: session.recording });
	return app;
}

test('recording work owns close eligibility through native finalization and row saving', async () => {
	const app = recordingApp({
		account: null,
		recordingEnabled: true,
		blobs: { removeLocal: async () => Ok(undefined) },
	});
	await app.recording.start();
	const stopping = app.recording.stop();
	expect(recordingActive(app as unknown as WhisperingApp)).toBe(true);
	await Bun.sleep(0);
	expect(events).toEqual(['finalize']);
	finalized.resolve();
	await Bun.sleep(0);
	expect(events).toEqual(['finalize', 'save']);
	app.recordingEnabled = false;
	const closing = closeRecordingWork().then(() => {
		events.push('producers closed');
	});
	expect(recordingActive(app as unknown as WhisperingApp)).toBe(true);
	saved.resolve();
	await stopping;
	await closing;
	expect(events.at(-1)).toBe('producers closed');
	expect(recordingActive(app as unknown as WhisperingApp)).toBe(false);
});

test('terminal producer closure releases an armed VAD engine after admission stops', async () => {
	vadRecorder.state = 'LISTENING';
	await closeRecordingWork();
	expect(vadRecorder.state).toBe('IDLE');
	expect(events.at(-1)).toBe('vad released');
});

test('VAD initialization owns close eligibility while recorder state remains idle', async () => {
	const app = recordingApp({
		recordingEnabled: true,
		settings: { set: mock() },
	});
	const starting = startVadRecording(app);
	expect(vadRecorder.state).toBe('IDLE');
	expect(recordingActive(app as unknown as WhisperingApp)).toBe(true);
	initialized.resolve();
	await starting;
	expect(recordingActive(app as unknown as WhisperingApp)).toBe(false);
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
		settings: { set: mock() },
	});
	await startVadRecording(app as unknown as WhisperingApp);
	app.recordingEnabled = false;
	const before = events.length;
	await speechEnd?.(new Blob(['late frame']));
	expect(events).toHaveLength(before);
	expect(recordingActive(app as unknown as WhisperingApp)).toBe(false);
});

test('a pipeline failure after saving does not delete published audio', async () => {
	finalized.resolve();
	saved.resolve();
	const removeLocal = mock(async () => Ok(undefined));
	const app = recordingApp({
		recordingEnabled: true,
		blobs: { removeLocal },
	});
	pipelineFailure = new Error('Post-save pipeline failed');
	try {
		await app.recording.start();
		await expect(app.recording.stop()).rejects.toBe(pipelineFailure);
		expect(removeLocal).not.toHaveBeenCalled();
		expect(recordingActive(app as unknown as WhisperingApp)).toBe(false);
	} finally {
		pipelineFailure = undefined;
	}
});

test('completed saving leaves attachment cleanup to its owner', async () => {
	finalized.resolve();
	saved.resolve();
	const removeLocal = mock(async () => Ok(undefined));
	const app = recordingApp({
		recordingEnabled: true,
		blobs: { removeLocal },
	});
	await app.recording.start();
	await app.recording.stop();
	expect(removeLocal).not.toHaveBeenCalled();
});

test('a stale push-to-talk ID cannot stop the current recording', async () => {
	const removeLocal = mock(async () => Ok(undefined));
	const app = recordingApp({ recordingEnabled: true, blobs: { removeLocal } });
	await app.recording.start();
	const before = events.length;
	await app.recording.stop(generateBlobId());
	expect(events).toHaveLength(before);
	expect(app.recording.state).toBe('RECORDING');
	await app.recording.stop(capture.id);
	expect(removeLocal).not.toHaveBeenCalled();
});

test('push-to-talk release during startup saves through the composed workflow', async () => {
	const { pushToTalk } = await import('./push-to-talk');
	const acquired = Promise.withResolvers<ReturnType<typeof Ok<Recording>>>();
	const service = {
		enumerateDevices: async () => Ok([]),
		current: async () => Ok(null),
		start: () => acquired.promise,
		discard: async () => Ok(undefined),
	} as RecordingService;
	const removeLocal = mock(async () => Ok(undefined));
	const app = recordingApp(
		{
			recordingEnabled: true,
			settings: { set: mock() },
			blobs: { removeLocal },
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
	expect(removeLocal).not.toHaveBeenCalled();
	expect(recordingActive(app)).toBe(false);
});

test('retirement retries the retained UI cleanup after unmount before releasing a failed active VAD', async () => {
	mock.module('../whispering/app', () => ({
		createWhisperingDomains: () => ({ settings: {}, [Symbol.dispose]() {} }),
	}));
	mock.module('../state/inference-connections.svelte.js', () => ({
		createWhisperingConnections: () => ({}),
	}));
	mock.module('../state/recordings.svelte', () => ({
		createRecordings: () => ({}),
	}));
	mock.module('../state/settings.svelte', () => ({
		createSettingsView: () => ({}),
	}));
	mock.module('../queries', () => ({ createWhisperingQueries: () => ({}) }));
	mock.module('../queries/client', () => ({
		createWhisperingQueryRuntime: () => ({ queryClient: { clear() {} } }),
	}));
	const { createWhisperingUiSession } = await import(
		'../whispering/ui-session'
	);
	const { createDeparture } = await import('@epicenter/app-shell/departure');
	const notification =
		Promise.withResolvers<import('@epicenter/data/store').LibraryRetirement>();
	const session = createWhisperingUiSession({
		selections: createInferenceSelections({
			storageKey: 'recording-close',
			storage: { getItem: () => null, setItem() {} },
		}),
		openedApp: {
			recording: { current: async () => Ok(null) },
		} as unknown as import('../whispering/app').WhisperingAppHandle,
		account: null,
	});
	let shell: { close(): Promise<void> } | undefined = {
		close: () => session[Symbol.asyncDispose](),
	};
	let closeUi: (() => Promise<void>) | undefined;
	let closed = false;
	let reloaded = false;
	const departure = createDeparture({
		account: null,
		retirement: notification.promise,
		close: async () => {
			closed = true;
		},
		reload: () => {
			reloaded = true;
		},
	});
	departure.attachUi({
		async quiesce() {
			closeUi ??= shell?.close;
			const closing = closeUi?.();
			shell = undefined;
			await closing;
		},
	});
	vadRecorder.state = 'LISTENING';
	vadFailure = new Error('Microphone graph still held');
	notification.resolve({
		invalidated: Promise.resolve(),
		retryInvalidation: () => Promise.resolve(),
	});
	try {
		await Bun.sleep(0);
		await expect(departure.close()).rejects.toBe(vadFailure);
		expect(shell).toBeUndefined();
		expect(closed).toBe(false);
		expect(reloaded).toBe(false);
		expect(vadRecorder.state).toBe('LISTENING');
		vadFailure = undefined;
		await departure.retryRetirement();
		expect(vadRecorder.state).toBe('IDLE');
		expect(closed).toBe(true);
		expect(reloaded).toBe(true);
	} finally {
		vadFailure = undefined;
		await closeRecordingWork();
	}
});
