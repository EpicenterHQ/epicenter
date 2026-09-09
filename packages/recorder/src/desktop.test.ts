/**
 * Native recording transport tests.
 * Pins captured destinations, recovered owner checks, one-shot resolution,
 * listener cleanup, and typed IPC failures without opening a microphone.
 */
import { expect, mock, test } from 'bun:test';
import { generateBlobId } from '@epicenter/blobs';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { NativeRecording } from './desktop.js';

let perform: (
	command: string,
	args?: Record<string, unknown>,
) => Promise<unknown>;
const invoke = mock((command: string, args?: Record<string, unknown>) =>
	perform(command, args),
);
const listeners = new Map<string, (event: { payload: unknown }) => void>();
const released: string[] = [];
mock.module('@tauri-apps/api/core', () => ({ invoke }));
mock.module('@tauri-apps/api/event', () => ({
	listen: async (
		name: string,
		handler: (event: { payload: unknown }) => void,
	) => {
		listeners.set(name, handler);
		return () => {
			listeners.delete(name);
			released.push(name);
		};
	},
}));
const { createDesktopRecording } = await import('./desktop.js');

function setup() {
	invoke.mockClear();
	listeners.clear();
	released.length = 0;
	const live: NativeRecording = {
		audioBlobId: generateBlobId(),
		destination: { appId: 'so.epicenter.test', scope: { kind: 'local' } },
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
	return { service: createDesktopRecording('so.epicenter.test', null), live };
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
				scope: {
					kind: 'account',
					authorityId: 'first',
					principalId: 'alice',
				},
			});
			live.destination = args?.destination as NativeRecording['destination'];
		}
		return original(command, args);
	};
	const service = createDesktopRecording('so.epicenter.test', account);
	account.authorityId = 'second';
	const started = service.start();
	permission.resolve('granted');
	const recording = expectOk(await started);
	expect(recording.account?.authorityId).toBe('first');
	expect(Reflect.set(recording, 'account', null)).toBe(false);
	expectOk(await recording.cancel());
});

test('recovery refuses a different app or account without ending the host capture', async () => {
	const { service, live } = setup();
	live.destination.appId = 'so.epicenter.another';
	expect(expectErr(await service.current()).name).toBe('AlreadyRecording');
	live.destination.appId = 'so.epicenter.test';
	live.destination.scope = {
		kind: 'account',
		authorityId: 'authority',
		principalId: 'alice',
	};
	expect(expectErr(await service.current()).name).toBe('AlreadyRecording');
	expect(
		invoke.mock.calls.every(([command]) => command === 'current_recording'),
	).toBe(true);
});

test('stop consumes the session once and releases subscriptions', async () => {
	const { service } = setup();
	const recording = expectOk(await service.start());
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
	const { service, live } = setup();
	const recording = expectOk(await service.start());
	live.endedReason = 'deviceDisconnected';
	const ended = Promise.withResolvers<string>();
	recording.onEnded((reason) => ended.resolve(reason));
	expect(await ended.promise).toBe('deviceDisconnected');
	expect(recording.endedReason).toBe('deviceDisconnected');
	expectOk(await recording.stop());
	expect(released).toContain('recording-ended-event');
});

test('native permission errors retain their actionable category', async () => {
	const { service } = setup();
	perform = async () => {
		throw { name: 'PermissionDenied', message: 'Denied' };
	};
	expect(expectErr(await service.start()).name).toBe(
		'MicrophonePermissionDenied',
	);
	expect(invoke).toHaveBeenCalledTimes(1);
});

test('current refreshes the held session after capture ends without a subscriber', async () => {
	const { service, live } = setup();
	const recording = expectOk(await service.start());
	live.endedReason = 'deviceDisconnected';
	expect(expectOk(await service.current())).toBe(recording);
	expect(recording.endedReason).toBe('deviceDisconnected');
	expectOk(await recording.cancel());
});
