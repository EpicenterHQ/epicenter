import { expect, mock, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import type { WhisperingApp } from '$lib/whispering/app';

Reflect.set(globalThis, '$state', <T>(value: T) => value);
const finalized = Promise.withResolvers<void>();
const saved = Promise.withResolvers<void>();
const initialized = Promise.withResolvers<void>();
const events: string[] = [];
const manualRecorder = {
	state: 'IDLE',
	isStarting: false,
	async stopRecording() {
		events.push('finalize');
		await finalized.promise;
		return Ok({ audioBlobId: 'source', durationMs: 100, byteLength: 10 });
	},
};
let speechEnd: ((blob: Blob) => Promise<void>) | undefined;
const vadRecorder = {
	state: 'IDLE',
	async startActiveListening(options: { onSpeechEnd(blob: Blob): Promise<void> }) {
		speechEnd = options.onSpeechEnd;
		events.push('initialize');
		await initialized.promise;
		return Ok({ outcome: 'success' });
	},
};
mock.module('../state/manual-recorder.svelte', () => ({ manualRecorder }));
mock.module('$lib/state/manual-recorder.svelte', () => ({ manualRecorder }));
mock.module('../state/vad-recorder.svelte', () => ({ vadRecorder }));
mock.module('$lib/state/vad-recorder.svelte', () => ({ vadRecorder }));
mock.module('#platform/manual-recorder-config', () => ({
	manualRecorderConfig: {},
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
		events.push('save');
		await saved.promise;
	},
}));
mock.module('$lib/operations/sound', () => ({ playSoundIfEnabled: mock() }));
mock.module('$lib/operations/transcribe', () => ({
	prewarmOnDeviceModel: mock(),
}));
mock.module('$lib/report', () => ({ report: { info: mock(), error: mock() } }));
mock.module('@epicenter/recorder/recording', () => ({ RecorderError: {} }));
mock.module('$lib/state/capture-surface.svelte', () => ({
	captureSurface: { dismissImport: mock() },
}));
mock.module('$lib/state/device-config.svelte', () => ({
	deviceConfig: { set: mock() },
}));
mock.module('$lib/state/dictation-lifecycle.svelte', () => ({
	dictationLifecycle: { reset: mock(), markFailed: mock() },
}));
const activity = await import('../state/recording-active.svelte');
const { recordingActive } = activity;
mock.module('$lib/state/recording-active.svelte', () => activity);
const {
	stopManualRecording,
	startVadRecording,
	startManualRecording,
	cancelRecording,
	stopVadRecording,
} = await import('./recording');

test('recording work owns close eligibility through native finalization and row saving', async () => {
	const app = {
		account: null,
		recordingEnabled: true,
		blobs: { removeLocal: async () => Ok(undefined) },
	} as unknown as WhisperingApp;
	const stopping = stopManualRecording(app);
	expect(recordingActive.current).toBe(true);
	expect(events).toEqual(['finalize']);
	finalized.resolve();
	await Bun.sleep(0);
	expect(events).toEqual(['finalize', 'save']);
	expect(recordingActive.current).toBe(true);
	saved.resolve();
	await stopping;
	expect(recordingActive.current).toBe(false);
});

test('VAD initialization owns close eligibility while recorder state remains idle', async () => {
	const app = {
		recordingEnabled: true,
		settings: { set: mock() },
	} as unknown as WhisperingApp;
	const starting = startVadRecording(app);
	expect(vadRecorder.state).toBe('IDLE');
	expect(recordingActive.current).toBe(true);
	initialized.resolve();
	await starting;
	expect(recordingActive.current).toBe(false);
});

test('queued capture actions cannot restart a disposed UI session', async () => {
	const app = { recordingEnabled: false } as WhisperingApp;
	const before = events.length;
	expect(await startManualRecording(app)).toBeNull();
	await startVadRecording(app);
	await stopManualRecording(app);
	await cancelRecording(app);
	await stopVadRecording(app);
	expect(events).toHaveLength(before);
});


test('a late VAD frame cannot save through its retired App', async () => {
	const app = { recordingEnabled: true, settings: { set: mock() } };
	await startVadRecording(app as unknown as WhisperingApp);
	app.recordingEnabled = false;
	const before = events.length;
	await speechEnd?.(new Blob(['late frame']));
	expect(events).toHaveLength(before);
	expect(recordingActive.current).toBe(false);
});
