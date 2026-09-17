/**
 * Disposable capture saves finished output in its captured library. Deferred
 * acquisition, save, cancellation and stale callbacks exercise caller ordering;
 * actual storage durability is covered by the store and native adapter suites.
 */
import { afterAll, expect, mock, setSystemTime, test } from 'bun:test';
import {
	RecorderError,
	type Recording,
	type RecordingService,
} from '@epicenter/app/recorder';
import { generateBlobId } from '@epicenter/blobs';
import { InstantString } from '@epicenter/data/field';
import { asDeviceIdentifier } from '@epicenter/recorder';
import { Ok, type Result } from 'wellcrafted/result';
import type { WhisperingApp } from '$lib/whispering/app';

Reflect.set(
	globalThis,
	'$state',
	Object.assign(<T>(value: T) => value, { raw: <T>(value: T) => value }),
);
const vadRecorder = { state: 'IDLE' };
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
const pipeline = mock(
	async (_app: WhisperingApp, _input: Record<string, unknown>) => {},
);
mock.module('$lib/operations/pipeline', () => ({
	processRecordingPipeline: pipeline,
}));
let inference = async () => Ok('original');
mock.module('$lib/operations/transcribe', () => ({
	captureTranscription: () => inference,
}));
mock.module('$lib/operations/sound', () => ({ playSoundIfEnabled: mock() }));
const reportError = mock();
mock.module('$lib/report', () => ({
	report: { info: mock(), error: reportError },
}));
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
mock.module('$lib/state/recording-active.svelte', () => activity);
const { createWhisperingRecording } = await import('./recording.svelte.js');

let nativeInvoke: (
	command: string,
	args?: Record<string, unknown>,
) => Promise<unknown>;
const tauriCore = { ...(await import('@tauri-apps/api/core')) };
const tauriEvent = { ...(await import('@tauri-apps/api/event')) };
afterAll(() => {
	mock.module('@tauri-apps/api/core', () => tauriCore);
	mock.module('@tauri-apps/api/event', () => tauriEvent);
});
mock.module('@tauri-apps/api/core', () => ({
	invoke: (command: string, args?: Record<string, unknown>) =>
		nativeInvoke(command, args),
}));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
const { createDesktopRecording } = await import(
	'../../../../../packages/app/src/recording/desktop.js'
);

function setup(service?: RecordingService) {
	const blobId = generateBlobId('wav');
	const stop = mock<Recording['stop']>(async () =>
		Ok({ blobId, durationMs: 1250, byteLength: 14 }),
	);
	const cancel = mock<Recording['cancel']>(async () => Ok(undefined));
	const unlevel = mock();
	const unsubscribe = mock();
	let ended: (() => void) | undefined;
	const recording: Recording = {
		id: crypto.randomUUID(),
		device: { outcome: 'success', deviceId: asDeviceIdentifier('mic') },
		endedReason: null,
		stop,
		cancel,
		onLevel: () => unlevel,
		onEnded: (handler) => {
			ended = () => handler('deviceDisconnected');
			return unsubscribe;
		},
	};
	const start = mock<RecordingService['start']>(async () => Ok(recording));
	const current = mock<RecordingService['current']>(async () => Ok(null));
	const create = mock<WhisperingApp['recordings']['create']>(async () =>
		Ok({ id: 'saved-row' } as never),
	);
	const remove = mock();
	const controller = new AbortController();
	const app = {
		signal: controller.signal,
		recordingEnabled: true,
		recordings: { create, delete: remove, get: () => ({ id: 'saved-row' }) },
		settings: { set: mock() },
	} as unknown as WhisperingApp;
	const session = createWhisperingRecording(
		app,
		service ?? {
			current,
			start,
			enumerateDevices: async () => Ok([]),
		},
	);
	Object.defineProperty(app, 'recording', { value: session.recording });
	return {
		app,
		controller,
		session,
		recorder: session.recording,
		recording,
		blobId,
		start,
		current,
		stop,
		cancel,
		create,
		remove,
		unlevel,
		unsubscribe,
		end: () => ended?.(),
	};
}

test('capture creates no row and stop saves finished bytes and duration before original inference', async () => {
	const f = setup();
	const original = inference;
	expect(await f.recorder.start()).toBe(f.recording.id);
	expect(f.create).not.toHaveBeenCalled();
	expect(f.current).not.toHaveBeenCalled();
	inference = async () => Ok('changed');
	await f.recorder.stop();
	expect(f.create).toHaveBeenCalledWith(
		expect.objectContaining({ audioBlobId: f.blobId, duration: 1250 }),
	);
	expect(pipeline).toHaveBeenLastCalledWith(
		f.app,
		expect.objectContaining({ recordingId: 'saved-row', transcribe: original }),
	);
	expect(f.recorder.saveStatus).toBe('saved');
});

test('duplicate starts are refused during acquisition', async () => {
	const f = setup();
	const started = Promise.withResolvers<Result<Recording, RecorderError>>();
	f.start.mockImplementationOnce(() => started.promise);
	const pending = f.recorder.start();
	expect(f.recorder.isStarting).toBe(true);
	expect(await f.recorder.start()).toBeNull();
	started.resolve(Ok(f.recording));
	expect(await pending).toBe(f.recording.id);
	await f.recorder.cancel();
});

for (const action of ['stop', 'cancel'] as const) {
	test(
		action + ' waits for acquisition and acts on the original capture',
		async () => {
			const f = setup();
			const started = Promise.withResolvers<Result<Recording, RecorderError>>();
			f.start.mockImplementationOnce(() => started.promise);
			const pending = f.recorder.start();
			const ending = f.recorder[action]();
			started.resolve(Ok(f.recording));
			await pending;
			await ending;
			expect(action === 'stop' ? f.stop : f.cancel).toHaveBeenCalledTimes(1);
			expect(f.recorder.state).toBe('IDLE');
		},
	);
}

test('late acquisition after disposal releases its session and creates no row', async () => {
	const f = setup();
	const started = Promise.withResolvers<Result<Recording, RecorderError>>();
	f.start.mockImplementationOnce(() => started.promise);
	const pending = f.recorder.start();
	f.session[Symbol.dispose]();
	started.resolve(Ok(f.recording));
	expect(await pending).toBeNull();
	expect(f.cancel).toHaveBeenCalledTimes(1);
	expect(f.create).not.toHaveBeenCalled();
});

test('Saved waits for persistence and another capture cannot bypass the save bound', async () => {
	const f = setup();
	const saved =
		Promise.withResolvers<
			Awaited<ReturnType<typeof f.app.recordings.create>>
		>();
	f.create.mockImplementationOnce(() => saved.promise);
	await f.recorder.start();
	const pending = f.recorder.stop();
	await Bun.sleep(0);
	expect(f.recorder.saveStatus).toBe('saving');
	expect(await f.recorder.start()).toBeNull();
	saved.resolve(Ok({ id: 'saved-row' } as never));
	await pending;
	expect(f.recorder.saveStatus).toBe('saved');
});

test('unconfirmed save never remints, deletes a row, or starts inference', async () => {
	const f = setup();
	const { RecordingCreationError } = await import(
		'../whispering/recordings.js'
	);
	f.create.mockImplementationOnce(async () =>
		RecordingCreationError.RowCreateFailed({
			audioBlobId: f.blobId,
			cause: 'disk full',
		}),
	);
	await f.recorder.start();
	const count = pipeline.mock.calls.length;
	await f.recorder.stop();
	await f.recorder.stop();
	expect(f.recorder.saveStatus).toBe('unconfirmed');
	expect(f.create).toHaveBeenCalledTimes(1);
	expect(f.remove).not.toHaveBeenCalled();
	expect(pipeline.mock.calls.length).toBe(count);
});

test('failed cancellation retains its session for retry without deleting saved work', async () => {
	const f = setup();
	await f.recorder.start();
	f.cancel.mockImplementationOnce(async () =>
		RecorderError.RecorderFailed({ cause: 'lost response' }),
	);
	await f.recorder.cancel();
	expect(f.recorder.state).toBe('RECORDING');
	await f.recorder.cancel();
	expect(f.cancel).toHaveBeenCalledTimes(2);
	expect(f.remove).not.toHaveBeenCalled();
});

test('stop failure permits exact-session retry and saves once', async () => {
	const f = setup();
	await f.recorder.start();
	f.stop.mockImplementationOnce(async () =>
		RecorderError.RecorderFailed({ cause: 'lost response' }),
	);
	await f.recorder.stop();
	expect(f.recorder.state).toBe('RECORDING');
	await f.recorder.stop();
	expect(f.create).toHaveBeenCalledTimes(1);
});

test('unexpected capture termination uses the same finished-file save operation', async () => {
	const f = setup();
	await f.recorder.start();
	f.end();
	await Bun.sleep(0);
	expect(f.create).toHaveBeenCalledTimes(1);
	expect(f.unlevel).toHaveBeenCalledTimes(1);
	expect(f.unsubscribe).toHaveBeenCalledTimes(1);
});

test('old callbacks and stale push-to-talk releases cannot stop the next capture', async () => {
	const f = setup();
	await f.recorder.start();
	const oldEnd = f.end;
	await f.recorder.stop();
	const nextStop = mock<Recording['stop']>(async () =>
		Ok({ blobId: f.blobId, durationMs: 1, byteLength: 2 }),
	);
	f.start.mockImplementationOnce(async () =>
		Ok({ ...f.recording, id: 'next', stop: nextStop, onEnded: () => () => {} }),
	);
	await f.recorder.start();
	oldEnd();
	await f.recorder.stop(f.recording.id);
	expect(nextStop).not.toHaveBeenCalled();
	await f.recorder.cancel();
});

function nativeWorkflow({
	lostStartReplies = 0,
	lostChecks = 0,
	terminalStop = false,
	lostStopReply = false,
} = {}) {
	let active = false;
	const live = {
		audioBlobId: 'blob_aaaaaaaaaaaaaaaaaaaaa.wav',
		device: { outcome: 'success', deviceId: 'mic' },
		endedReason: null,
	};
	const finished = {
		blobId: 'blob_aaaaaaaaaaaaaaaaaaaaa.wav',
		durationMs: 1_000,
		byteLength: 96_044,
	};
	const requests: unknown[] = [];
	let cancellations = 0;
	nativeInvoke = async (command, args) => {
		switch (command) {
			case 'register_recording_session':
				return;
			case 'request_microphone_permission':
				return 'granted';
			case 'start_recording':
				requests.push(args?.requestId);
				active = true;
				if (lostStartReplies-- > 0) throw new Error('Lost Start response');
				return live;
			case 'current_recording':
			case 'resolve_recording_start':
				if (lostChecks-- > 0) throw new Error('Lost status response');
				return active ? live : null;
			case 'stop_recording':
				active = false;
				if (terminalStop)
					throw {
						name: 'CaptureLost',
						message: 'Finalization failed; no output remains.',
					};
				if (lostStopReply) {
					lostStopReply = false;
					throw new Error('Lost Stop response');
				}
				return finished;
			case 'cancel_recording':
				active = false;
				cancellations++;
				return;
			case 'close_recording_session':
				active = false;
				return;
			default:
				throw new Error('Unexpected IPC: ' + command);
		}
	};
	const owner = createDesktopRecording('so.epicenter.test', {
		write: async () => Ok(undefined),
	});
	return {
		...setup(owner.value),
		owner,
		requests,
		get cancellations() {
			return cancellations;
		},
	};
}

test('desktop reconciliation keeps a lost Start reply inside the original workflow', async () => {
	const f = nativeWorkflow({ lostStartReplies: 1 });
	const original = inference;
	try {
		expect(await f.recorder.start()).toBe('blob_aaaaaaaaaaaaaaaaaaaaa.wav');
		inference = async () => Ok('changed');
		await f.recorder.stop();
		expect(f.create).toHaveBeenCalledTimes(1);
		expect(pipeline).toHaveBeenLastCalledWith(
			f.app,
			expect.objectContaining({ transcribe: original }),
		);
	} finally {
		await f.owner.close();
		inference = original;
	}
});

test('uncertain native Start retains original inference and timestamp through a later retry', async () => {
	const f = nativeWorkflow({ lostStartReplies: 1, lostChecks: 1 });
	const original = inference;
	try {
		setSystemTime(new Date('2026-09-16T01:00:00.000Z'));
		expect(await f.recorder.start()).toBeNull();
		expect(f.recorder.isUncertain).toBe(true);
		setSystemTime(new Date('2026-09-16T02:00:00.000Z'));
		expect(activity.recordingActive(f.app)).toBe(true);
		inference = async () => Ok('changed');
		expect(await f.recorder.start()).toBe('blob_aaaaaaaaaaaaaaaaaaaaa.wav');
		await f.recorder.stop();
		expect(new Set(f.requests).size).toBe(1);
		expect(f.create).toHaveBeenCalledTimes(1);
		expect(f.create.mock.calls[0]?.[0].recordedAt).toBe(
			InstantString.fromDate(new Date('2026-09-16T01:00:00.000Z')),
		);
		expect(pipeline).toHaveBeenLastCalledWith(
			f.app,
			expect.objectContaining({ transcribe: original }),
		);
	} finally {
		setSystemTime();
		await f.owner.close();
		inference = original;
	}
});

test('Cancel resolves an uncertain desktop Start without saving a row', async () => {
	const f = nativeWorkflow({ lostStartReplies: 1, lostChecks: 1 });
	try {
		await f.recorder.start();
		expect(f.recorder.isUncertain).toBe(true);
		expect(await f.recorder.cancel()).toBe(true);
		expect(f.cancellations).toBe(1);
		expect(f.recorder.isUncertain).toBe(false);
		expect(activity.recordingActive(f.app)).toBe(false);
		expect(f.create).not.toHaveBeenCalled();
	} finally {
		await f.owner.close();
	}
});

test('uncertain Cancel excludes Retry until the original native capture is cancelled', async () => {
	const f = nativeWorkflow({ lostStartReplies: 1, lostChecks: 1 });
	const resolving = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	try {
		await f.recorder.start();
		const invoke = nativeInvoke;
		nativeInvoke = async (command, args) => {
			if (command === 'resolve_recording_start') {
				resolving.resolve();
				await release.promise;
			}
			return invoke(command, args);
		};
		const cancellation = f.recorder.cancel();
		await resolving.promise;
		expect(await f.recorder.start()).toBeNull();
		expect(f.requests).toHaveLength(1);
		release.resolve();
		expect(await cancellation).toBe(true);
		expect(f.recorder.state).toBe('IDLE');
		expect(f.recorder.isUncertain).toBe(false);
		expect(f.cancellations).toBe(1);
		expect(f.create).not.toHaveBeenCalled();
		expect(await f.recorder.start()).toBe('blob_aaaaaaaaaaaaaaaaaaaaa.wav');
	} finally {
		release.resolve();
		await f.owner.close();
	}
});

test('definite desktop Stop loss clears recording state while a lost reply stays retryable', async () => {
	const lost = nativeWorkflow({ terminalStop: true });
	try {
		await lost.recorder.start();
		await lost.recorder.stop();
		expect(lost.recorder.state).toBe('IDLE');
		expect(lost.recorder.saveStatus).toBe('failed');
		expect(lost.create).not.toHaveBeenCalled();
		expect(await lost.recorder.start()).toBe('blob_aaaaaaaaaaaaaaaaaaaaa.wav');
	} finally {
		await lost.owner.close();
	}
	const retried = nativeWorkflow({ lostStopReply: true });
	try {
		await retried.recorder.start();
		await retried.recorder.stop();
		expect(retried.recorder.state).toBe('RECORDING');
		await retried.recorder.stop();
		expect(retried.recorder.saveStatus).toBe('saved');
		expect(retried.create).toHaveBeenCalledTimes(1);
	} finally {
		await retried.owner.close();
	}
});
