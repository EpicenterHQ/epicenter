/**
 * The recording workflow binds one service and coordinates deferred capture.
 * Runes are shimmed for imperative assertions; UI invalidation is typechecked separately.
 */
import { expect, mock, test } from 'bun:test';
import {
	RecorderError,
	type Recording,
	type RecordingService,
} from '@epicenter/app/recorder';
import { asDeviceIdentifier } from '@epicenter/recorder';
import { Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
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
const reportRecordingMicLevel = mock();
mock.module('#platform/recording-mic-level', () => ({
	reportRecordingMicLevel,
}));
mock.module('$app/navigation', () => ({ goto: mock() }));
mock.module('$app/paths', () => ({ resolve: (path: string) => path }));
mock.module('$lib/operations/analytics', () => ({ logAnalyticsEvent: mock() }));
mock.module('$lib/operations/media', () => ({
	recordingMedia: { resume: mock(), pause: mock() },
}));
const pipeline = mock(
	async (
		_app: WhisperingApp,
		_input: { recordingId: string; durationMs: number },
	) => {},
);
mock.module('$lib/operations/pipeline', () => ({
	processRecordingPipeline: pipeline,
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
mock.module('$lib/state/recording-active.svelte', () => activity);
const { createWhisperingRecording } = await import('./recording.svelte.js');

function setup() {
	const id = crypto.randomUUID();
	const into = { rowId: crypto.randomUUID() } as Recording['into'];
	const unsubscribe = mock();
	const unlevel = mock();
	const onLevel = mock(() => unlevel);
	let ended: ((reason: 'deviceDisconnected') => void) | undefined;
	const cancel = mock<Recording['cancel']>(async () => Ok(undefined));
	const stop = mock(async () => Ok({ durationMs: 1, byteLength: 2 }));
	const recording: Recording = {
		id,
		into,
		replica: { library: 'local' },
		device: { outcome: 'success', deviceId: asDeviceIdentifier('mic') },
		endedReason: null,
		stop,
		cancel,
		onLevel,
		onEnded: (handler) => {
			ended = handler;
			return unsubscribe;
		},
	};
	const current = mock<RecordingService['current']>(async () => Ok(null));
	const start = mock<RecordingService['start']>(async () => Ok(recording));
	const create = mock(async () => Ok({ id: into.rowId }));
	const get = mock(() => ({ id: into.rowId, audio: null as string | null }));
	const remove = mock(async () => Ok(undefined));
	const app = {
		signal: new AbortController().signal,
		recordingEnabled: true,
		recordings: {
			create,
			attachment: () => into,
			get,
			patch: mock(),
			delete: remove,
		},
		settings: { set: mock() },
		blobs: { removeLocal: async () => Ok(undefined) },
	} as unknown as WhisperingApp;
	const session = createWhisperingRecording(app, {
		current,
		start,
		enumerateDevices: async () => Ok([]),
	});
	Object.defineProperty(app, 'recording', { value: session.recording });
	const recorder = session.recording;
	return {
		app,
		create,
		get,
		remove,
		recorder,
		session,
		current,
		start,
		recording,
		stop,
		cancel,
		unsubscribe,
		onLevel,
		unlevel,
		end: () => ended?.('deviceDisconnected'),
	};
}

test('constructing workflows acquires nothing and they cannot retarget each other', async () => {
	const old = setup();
	const next = setup();
	expect(old.current).not.toHaveBeenCalled();
	expect(old.start).not.toHaveBeenCalled();
	const recovery =
		Promise.withResolvers<Result<Recording | null, RecorderError>>();
	old.current.mockImplementationOnce(() => recovery.promise);
	const oldRecovery = old.recorder.recover();
	expect(await next.recorder.start()).toBe(next.recording.id);
	recovery.resolve(Ok(old.recording));
	expectOk(await oldRecovery);
	expect(await old.recorder.cancel()).toBe(true);
	expect(old.cancel).toHaveBeenCalledTimes(1);
	expect(next.cancel).not.toHaveBeenCalled();
	expect(next.recorder.state).toBe('RECORDING');
});

test('duplicate starts are refused while startup is pending', async () => {
	const { recorder, start, recording } = setup();
	const startup = Promise.withResolvers<Result<Recording, RecorderError>>();
	start.mockImplementationOnce(() => startup.promise);
	const pending = recorder.start();
	expect(recorder.isStarting).toBe(true);
	expect(await recorder.start()).toBeNull();
	startup.resolve(Ok(recording));
	expect(await pending).toBe(recording.id);
	expect(recorder.isStarting).toBe(false);
});

for (const action of ['stop', 'cancel'] as const) {
	test(`${action} waits for startup and resolves the captured recording once`, async () => {
		const { recorder, start, recording, stop, cancel } = setup();
		const startup = Promise.withResolvers<Result<Recording, RecorderError>>();
		start.mockImplementationOnce(() => startup.promise);
		const pendingStart = recorder.start();
		let finished = false;
		const pendingEnd = recorder[action]().then((result) => {
			expect(result).toBe(action === 'cancel' ? true : undefined);
			finished = true;
		});
		await Promise.resolve();
		expect(finished).toBe(false);
		startup.resolve(Ok(recording));
		expect(await pendingStart).toBe(recording.id);
		await pendingEnd;
		expect(action === 'stop' ? stop : cancel).toHaveBeenCalledTimes(1);
		expect(recorder.state).toBe('IDLE');
	});
}

test('recovery failure can be retried and recovered capture can be stopped', async () => {
	const { recorder, current, recording, stop } = setup();
	current.mockImplementationOnce(async () => RecorderError.AlreadyRecording());
	expectErr(await recorder.recover());
	current.mockImplementationOnce(async () => Ok(recording));
	await recorder.stop();
	expect(stop).toHaveBeenCalledTimes(1);
});

test('disposal releases UI subscriptions without cancelling App-owned capture', async () => {
	const { recorder, session, current, recording, unsubscribe, cancel } =
		setup();
	current.mockImplementationOnce(async () => Ok(recording));
	expectOk(await recorder.recover());
	session[Symbol.dispose]();
	session[Symbol.dispose]();
	expect(unsubscribe).toHaveBeenCalledTimes(1);
	expect(cancel).not.toHaveBeenCalled();
	expect(await recorder.start()).toBeNull();
	expect(recorder.state).toBe('IDLE');
});

test('late recovery cannot attach capture to a disposed UI session', async () => {
	const { recorder, session, current, recording, unsubscribe } = setup();
	const recovery =
		Promise.withResolvers<Result<Recording | null, RecorderError>>();
	current.mockImplementationOnce(() => recovery.promise);
	const pending = recorder.recover();
	session[Symbol.dispose]();
	recovery.resolve(Ok(recording));
	expectErr(await pending);
	expect(recorder.state).toBe('IDLE');
	expect(unsubscribe).not.toHaveBeenCalled();
});

test('unexpected capture termination runs the same stop-and-save workflow', async () => {
	const { recorder, recording, stop, end, unsubscribe } = setup();
	expect(await recorder.start()).toBe(recording.id);
	end();
	await Bun.sleep(0);
	expect(stop).toHaveBeenCalledTimes(1);
	expect(unsubscribe).toHaveBeenCalledTimes(1);
	expect(recorder.state).toBe('IDLE');
});

test('recovery restores recording state and meter once without starting another capture', async () => {
	const { recorder, session, current, recording, start, onLevel, unlevel } =
		setup();
	const recovery =
		Promise.withResolvers<Result<Recording | null, RecorderError>>();
	current.mockImplementationOnce(() => recovery.promise);
	const pending = recorder.recover();
	expect(recorder.recover()).toBe(pending);
	recovery.resolve(Ok(recording));
	expectOk(await pending);
	expect(recorder.state).toBe('RECORDING');
	expect(start).not.toHaveBeenCalled();
	expect(onLevel).toHaveBeenCalledTimes(1);
	expect(onLevel).toHaveBeenCalledWith(reportRecordingMicLevel);
	expectOk(await recorder.recover());
	expect(onLevel).toHaveBeenCalledTimes(1);
	session[Symbol.dispose]();
	expect(unlevel).toHaveBeenCalledTimes(1);
});

test('cancelling recovered capture releases its meter subscription', async () => {
	const { recorder, current, recording, unlevel } = setup();
	current.mockImplementationOnce(async () => Ok(recording));
	expectOk(await recorder.recover());
	expect(await recorder.cancel()).toBe(true);
	expect(unlevel).toHaveBeenCalledTimes(1);
	expect(recorder.state).toBe('IDLE');
});

test('recovery saves capture that ended while the page was absent once', async () => {
	const { recorder, current, recording, stop, unlevel } = setup();
	const ended = {
		...recording,
		endedReason: 'deviceDisconnected' as const,
		onEnded(handler: Parameters<Recording['onEnded']>[0]) {
			queueMicrotask(() => handler('deviceDisconnected'));
			return () => {};
		},
	};
	current.mockImplementationOnce(async () => Ok(ended));
	expectOk(await recorder.recover());
	await Bun.sleep(0);
	expect(stop).toHaveBeenCalledTimes(1);
	expect(unlevel).toHaveBeenCalledTimes(1);
	expect(recorder.state).toBe('IDLE');
	expectOk(await recorder.recover());
	expect(stop).toHaveBeenCalledTimes(1);
});

test('capture starts only after its row exists and stop transcribes that same row', async () => {
	const fixture = setup();
	const created =
		Promise.withResolvers<ReturnType<typeof Ok<{ id: string }>>>();
	fixture.create.mockImplementationOnce(() => created.promise);
	const starting = fixture.recorder.start();
	await Bun.sleep(0);
	expect(fixture.start).not.toHaveBeenCalled();
	created.resolve(Ok({ id: fixture.recording.into.rowId }));
	await starting;
	expect(fixture.start).toHaveBeenCalledWith({ into: fixture.recording.into });
	await fixture.recorder.stop(fixture.recording.id);
	expect(pipeline).toHaveBeenLastCalledWith(fixture.app, {
		recordingId: fixture.recording.into.rowId,
		durationMs: 1,
		isCurrentAttempt: expect.any(Function),
	});
	expect(fixture.create).toHaveBeenCalledTimes(1);
});

test('an ended callback retained from the prior capture cannot stop its replacement', async () => {
	const fixture = setup();
	await fixture.recorder.start();
	const oldEnd = fixture.end;
	await fixture.recorder.stop(fixture.recording.id);
	const nextStop = mock(async () => Ok({ durationMs: 1, byteLength: 2 }));
	fixture.start.mockImplementationOnce(async () =>
		Ok({
			...fixture.recording,
			id: 'next-capture',
			stop: nextStop,
			onEnded: () => () => {},
		}),
	);
	await fixture.recorder.start();
	oldEnd();
	await Bun.sleep(0);
	expect(nextStop).not.toHaveBeenCalled();
	expect(fixture.recorder.state).toBe('RECORDING');
	fixture.session[Symbol.dispose]();
});

test('cancelling recovery after local completion preserves its saved row', async () => {
	const fixture = setup();
	fixture.current.mockImplementationOnce(async () => Ok(fixture.recording));
	fixture.get.mockImplementation(() => ({
		id: fixture.recording.into.rowId,
		audio: 'audio/wav',
	}));
	await fixture.recorder.recover();
	await fixture.recorder.cancel();
	expect(fixture.cancel).toHaveBeenCalledTimes(1);
	expect(fixture.remove).not.toHaveBeenCalled();
});

test('failed cancellation can recover and retry through the same controls before starting again', async () => {
	const fixture = setup();
	await fixture.recorder.start();
	fixture.cancel.mockImplementationOnce(async () =>
		RecorderError.RecorderFailed({ cause: new Error('temporary IPC failure') }),
	);
	fixture.current.mockImplementationOnce(async () => Ok(fixture.recording));
	expect(await fixture.recorder.cancel()).toBe(true);
	expect(fixture.remove).not.toHaveBeenCalled();
	expect(await fixture.recorder.cancel()).toBe(true);
	expect(fixture.current).toHaveBeenCalledTimes(2);
	expect(fixture.cancel).toHaveBeenCalledTimes(2);
	expect(fixture.remove).toHaveBeenCalledWith(fixture.recording.into.rowId);
	expect(await fixture.recorder.start()).toBe(fixture.recording.id);
	expect(fixture.start).toHaveBeenCalledTimes(2);
	fixture.session[Symbol.dispose]();
});
