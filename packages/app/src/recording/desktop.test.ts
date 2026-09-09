/**
 * Native recording transport tests.
 * Pins captured destinations, recovered owner checks, one-shot resolution,
 * listener cleanup, and typed IPC failures without opening a microphone.
 */
import { expect, mock, test } from 'bun:test';
import { createBrowserBlobStore } from '@epicenter/blobs/browser';
import { generateBlobId } from '@epicenter/blobs';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { NativeRecording } from '../recorder.js';

let perform: (
	command: string,
	args?: Record<string, unknown>,
) => Promise<unknown>;
const invoke = mock((command: string, args?: Record<string, unknown>) =>
	perform(command, args),
);
const listeners = new Map<string, (event: { payload: unknown }) => void>();
const released: string[] = [];
let registration: Promise<void> | undefined;
let unlistenFailure: Error | undefined;
let nativeUnlisten: Promise<void> | undefined;
mock.module('@tauri-apps/api/core', () => ({ invoke }));
mock.module('@tauri-apps/api/event', () => ({
	listen: async (
		name: string,
		handler: (event: { payload: unknown }) => void,
	) => {
		if (registration) await registration;
		listeners.set(name, handler);
		return () => {
			listeners.delete(name);
			released.push(name);
			if (unlistenFailure) throw unlistenFailure;
			return nativeUnlisten;
		};
	},
}));
const { createDesktopRecording } = await import('./desktop.js');

function setup() {
	invoke.mockClear();
	registration = undefined;
	unlistenFailure = undefined;
	nativeUnlisten = undefined;
	listeners.clear();
	released.length = 0;
	const live: NativeRecording = {
		audioBlobId: generateBlobId(),
		destination: { appId: 'so.epicenter.test', replica: { library: 'local' } },
		device: { outcome: 'success', deviceId: 'mic' },
		endedReason: null,
	};
	perform = async (command) => {
		switch (command) {
			case 'request_microphone_permission':
			case 'get_microphone_permission':
				return 'granted';
			case 'start_recording':
			case 'current_recording':
				return live;
			case 'stop_recording':
				return {
					audioBlobId: live.audioBlobId,
					durationMs: 100,
					byteLength: 3200,
				};
			case 'cancel_recording':
				return;
			case 'enumerate_recording_devices':
				return ['mic'];
			default:
				throw new Error(`Unexpected command: ${command}`);
		}
	};
	return {
		owner: createDesktopRecording(
			'so.epicenter.test',
			{ library: 'local' },
			{
				local: createBrowserBlobStore({
					appId: 'so.epicenter.test',
					replica: { library: 'local' as const },
				}),
			},
		),
		live,
	};
}

test('construction is inert and start captures destination before permission completes', async () => {
	const { live } = setup();
	expect(invoke).not.toHaveBeenCalled();
	const permission = Promise.withResolvers<string>();
	const account = { authorityId: 'first', principalId: asPrincipalId('alice') };
	const original = perform;
	perform = async (command, args) => {
		if (command === 'request_microphone_permission') return permission.promise;
		if (command === 'start_recording') {
			expect(args?.destination).toEqual({
				appId: 'so.epicenter.test',
				replica: {
					library: 'personal',
					account: { authorityId: 'first', principalId: 'alice' },
				},
			});
			live.destination = args?.destination as NativeRecording['destination'];
		}
		return original(command, args);
	};
	const owner = createDesktopRecording(
		'so.epicenter.test',
		{ library: 'personal', account },
		{
			local: createBrowserBlobStore({
				appId: 'so.epicenter.test',
				replica: { library: 'personal', account },
			}),
		},
	);
	account.authorityId = 'second';
	const started = owner.value.start();
	permission.resolve('granted');
	const recording = expectOk(await started);
	expect(
		recording.replica.library === 'local'
			? undefined
			: recording.replica.account.authorityId,
	).toBe('first');
	expect(Reflect.set(recording, 'replica', { library: 'local' })).toBe(false);
	expectOk(await recording.cancel());
});

test('recovery refuses a different app or account without ending the host capture', async () => {
	const { owner, live } = setup();
	live.destination.appId = 'so.epicenter.another';
	expect(expectErr(await owner.value.current()).name).toBe('AlreadyRecording');
	live.destination.appId = 'so.epicenter.test';
	live.destination.replica = {
		library: 'personal',
		account: { authorityId: 'authority', principalId: 'alice' },
	};
	expect(expectErr(await owner.value.current()).name).toBe('AlreadyRecording');
	expect(
		invoke.mock.calls.every(([command]) => command === 'current_recording'),
	).toBe(true);
});

test('stop consumes the session once and releases subscriptions', async () => {
	const { owner } = setup();
	const recording = expectOk(await owner.value.start());
	recording.onLevel(() => {});
	const stopping = recording.stop();
	expect(expectErr(await recording.stop()).name).toBe('NoActiveRecording');
	expect(expectErr(await recording.cancel()).name).toBe('NoActiveRecording');
	expectOk(await stopping);
	expect(
		invoke.mock.calls.filter(([command]) => command === 'stop_recording'),
	).toHaveLength(1);
	expect(released).toContain('mic-level');
});

test('reconciliation delivers an ending missed before subscription and preserves stop', async () => {
	const { owner, live } = setup();
	const recording = expectOk(await owner.value.start());
	live.endedReason = 'deviceDisconnected';
	const ended = Promise.withResolvers<string>();
	recording.onEnded((reason) => ended.resolve(reason));
	expect(await ended.promise).toBe('deviceDisconnected');
	expect(recording.endedReason).toBe('deviceDisconnected');
	expectOk(await recording.stop());
	expect(released).toContain('recording-ended-event');
});

test('native permission errors retain their actionable category', async () => {
	const { owner } = setup();
	perform = async () => {
		throw { name: 'PermissionDenied', message: 'Denied' };
	};
	expect(expectErr(await owner.value.start()).name).toBe(
		'MicrophonePermissionDenied',
	);
	expect(invoke).toHaveBeenCalledTimes(1);
});

test('current refreshes the held session after capture ends without a subscriber', async () => {
	const { owner, live } = setup();
	const recording = expectOk(await owner.value.start());
	live.endedReason = 'deviceDisconnected';
	expect(expectOk(await owner.value.current())).toBe(recording);
	expect(recording.endedReason).toBe('deviceDisconnected');
	expectOk(await recording.cancel());
});

test('close waits for native startup and cancels the late capture', async () => {
	const { owner } = setup();
	const permission = Promise.withResolvers<string>();
	const original = perform;
	perform = (command, args) =>
		command === 'request_microphone_permission'
			? permission.promise
			: original(command, args);
	const starting = owner.value.start();
	const closing = owner.close();
	expect(owner.close()).toBe(closing);
	expect(() => owner.value.start()).toThrow('closed');
	expect(() => owner.value.current()).toThrow('closed');
	expect(() => owner.value.enumerateDevices()).toThrow('closed');
	permission.resolve('granted');
	const recording = expectOk(await starting);
	await closing;
	expect(
		invoke.mock.calls.filter(([command]) => command === 'cancel_recording'),
	).toHaveLength(1);
	expect(() => recording.stop()).toThrow('closed');
	expect(() => recording.cancel()).toThrow('closed');
	expect(() => recording.onLevel(() => {})).toThrow('closed');
	expect(() => recording.onEnded(() => {})).toThrow('closed');
});

test('close drains an admitted native stop before recovery or cancellation', async () => {
	const { owner } = setup();
	const recording = expectOk(await owner.value.start());
	const publication = Promise.withResolvers<void>();
	const original = perform;
	perform = async (command, args) => {
		if (command === 'stop_recording') await publication.promise;
		if (command === 'current_recording') return null;
		return original(command, args);
	};
	const stopping = recording.stop();
	const closing = owner.close();
	let finished = false;
	void closing.then(() => {
		finished = true;
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	expect(
		invoke.mock.calls.some(([command]) => command === 'current_recording'),
	).toBe(false);
	publication.resolve();
	expectOk(await stopping);
	await closing;
	expect(
		invoke.mock.calls.some(([command]) => command === 'cancel_recording'),
	).toBe(false);
});

test('refused recovery performs no native calls but own capture is still cancelled', async () => {
	setup();
	const refused = createDesktopRecording(
		'so.epicenter.test',
		{ library: 'local' },
		{
			local: createBrowserBlobStore({
				appId: 'so.epicenter.test',
				replica: { library: 'local' as const },
			}),
			canRecover: () => false,
		},
	);
	await refused.close();
	expect(invoke).not.toHaveBeenCalled();
	const owner = createDesktopRecording(
		'so.epicenter.test',
		{ library: 'local' },
		{
			local: createBrowserBlobStore({
				appId: 'so.epicenter.test',
				replica: { library: 'local' as const },
			}),
			canRecover: () => false,
		},
	);
	expectOk(await owner.value.start());
	await owner.close();
	expect(
		invoke.mock.calls.filter(([command]) => command === 'cancel_recording'),
	).toHaveLength(1);
});

test('close waits for late listener registration and unlistens before completing', async () => {
	const { owner } = setup();
	const pending = Promise.withResolvers<void>();
	registration = pending.promise;
	const recording = expectOk(await owner.value.start());
	recording.onLevel(() => {});
	const closing = owner.close();
	let finished = false;
	void closing.then(() => {
		finished = true;
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	pending.resolve();
	await closing;
	expect(released).toEqual(['mic-level']);
	expect(listeners.size).toBe(0);
});

test('failed native cancellation rejects the same terminal close promise', async () => {
	const { owner } = setup();
	expectOk(await owner.value.start());
	const original = perform;
	perform = async (command, args) => {
		if (command === 'cancel_recording') throw new Error('cancel failed');
		return original(command, args);
	};
	const closing = owner.close();
	await expect(closing).rejects.toMatchObject({ name: 'RecorderFailed' });
	expect(owner.close()).toBe(closing);
});

test('failed unlisten rejects close after attempting every listener release', async () => {
	const { owner } = setup();
	const recording = expectOk(await owner.value.start());
	recording.onLevel(() => {});
	recording.onEnded(() => {});
	unlistenFailure = new Error('unlisten failed');
	await expect(owner.close()).rejects.toThrow('cleanup failed');
	expect(released.toSorted()).toEqual(['mic-level', 'recording-ended-event']);
});

test('native readiness checks retained operations synchronously and close bypasses readiness', async () => {
	setup();
	let usable = false;
	const owner = createDesktopRecording(
		'so.epicenter.test',
		{ library: 'local' },
		{
			local: createBrowserBlobStore({
				appId: 'so.epicenter.test',
				replica: { library: 'local' as const },
			}),
			assertUsable() {
				if (!usable) throw new Error('not ready');
			},
		},
	);
	const start = owner.value.start;
	expect(() => start()).toThrow('not ready');
	usable = true;
	const recording = expectOk(await start());
	const cancel = recording.cancel;
	usable = false;
	expect(() => cancel()).toThrow('not ready');
	expect(() => recording.onLevel(() => {})).toThrow('not ready');
	await owner.close();
});

test('close awaits the promise returned by native unlisten despite its void type', async () => {
	const { owner } = setup();
	const pending = Promise.withResolvers<void>();
	nativeUnlisten = pending.promise;
	const recording = expectOk(await owner.value.start());
	recording.onLevel(() => {});
	const closing = owner.close();
	let finished = false;
	void closing.then(() => {
		finished = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(released).toEqual(['mic-level']);
	expect(finished).toBe(false);
	pending.resolve();
	await closing;
});

test('construction-only close cannot recover native capture without authorization', async () => {
	const { owner } = setup();
	await owner.close();
	expect(invoke).not.toHaveBeenCalled();
});

test('authorized close ignores capture owned by another destination', async () => {
	const { live } = setup();
	live.destination.appId = 'so.epicenter.another';
	const owner = createDesktopRecording(
		'so.epicenter.test',
		{ library: 'local' },
		{
			local: createBrowserBlobStore({
				appId: 'so.epicenter.test',
				replica: { library: 'local' as const },
			}),
			canRecover: () => true,
		},
	);
	expect(expectErr(await owner.value.current()).name).toBe('AlreadyRecording');
	await owner.close();
	expect(
		invoke.mock.calls.every(([command]) => command === 'current_recording'),
	).toBe(true);
});

test('close succeeds when its held native capture has already disappeared', async () => {
	const { owner } = setup();
	expectOk(await owner.value.start());
	const original = perform;
	perform = async (command, args) => {
		if (command === 'cancel_recording') throw { name: 'NotRecording' };
		return original(command, args);
	};
	await owner.close();
	expect(
		invoke.mock.calls.filter(([command]) => command === 'cancel_recording'),
	).toHaveLength(1);
});

test('cancel retains its native failure when listener release also fails', async () => {
	const { owner } = setup();
	const recording = expectOk(await owner.value.start());
	recording.onLevel(() => {});
	unlistenFailure = new Error('unlisten failed');
	const original = perform;
	perform = async (command, args) => {
		if (command === 'cancel_recording') throw { name: 'NotRecording' };
		return original(command, args);
	};
	expect(expectErr(await recording.cancel()).name).toBe('NoActiveRecording');
	await expect(owner.close()).rejects.toThrow('cleanup failed');
});
