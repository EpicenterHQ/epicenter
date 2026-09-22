/**
 * Disposable native capture transport tests.
 * Verifies document/request identity, saved-key Stop, lost response retries,
 * exact cleanup, and listener drainage. Physical evidence lives in Rust.
 */
import { expect, mock, test } from 'bun:test';
import { generateBlobId, parseBlobId } from '@epicenter/blobs';
import { asDeviceIdentifier } from '@epicenter/recorder';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { NativeRecording, RecordingOptions } from '../recorder.js';

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

function setup(options: Partial<RecordingOptions> = {}) {
	invoke.mockClear();
	registration = undefined;
	unlistenFailure = undefined;
	nativeUnlisten = undefined;
	listeners.clear();
	released.length = 0;
	const live: NativeRecording = {
		audioBlobId: generateBlobId('wav'),
		device: { outcome: 'success', deviceId: 'mic' },
		endedReason: null,
	};
	let active = false;
	perform = async (command) => {
		switch (command) {
			case 'request_microphone_permission':
			case 'get_microphone_permission':
				return 'granted';
			case 'recording_document_generation':
                return 1;
            case 'register_recording_session':
				return;
			case 'start_recording':
				active = true;
				return live;
			case 'current_recording':
			case 'resolve_recording_start':
				return active ? live : null;
			case 'stop_recording':
				active = false;
				return {
					blobId: live.audioBlobId,
					durationMs: 1000,
					byteLength: 96044,
				};
			case 'close_recording_session':
			case 'cancel_recording':
				active = false;
				return;
			case 'enumerate_recording_devices':
				return ['mic'];
			default:
				throw new Error('Unexpected native command: ' + command);
		}
	};
	return {
		owner: createDesktopRecording('so.epicenter.test', {
			write: async () => {
				throw new Error('Desktop must not write through WebView');
			},
			...options,
		}),
		live,
	};
}

test('construction and construction-only close acquire no native session', async () => {
	const { owner } = setup();
	expect(expectOk(await owner.value.current())).toBeNull();
	await owner.close();
	expect(invoke).not.toHaveBeenCalled();
});

test('Stop returns the admitted WAV key and refuses an unrelated saved receipt', async () => {
	const { owner, live } = setup();
	const recording = expectOk(await owner.value.start({}));
	expect(
		invoke.mock.calls.find(
			([command]) => command === 'register_recording_session',
		)?.[1],
	).not.toHaveProperty('account');
	const original = perform;
	perform = async (command, args) =>
		command === 'stop_recording'
			? { blobId: generateBlobId('wav'), durationMs: 1000, byteLength: 96044 }
			: original(command, args);
	expect(expectErr(await recording.stop()).name).toBe('RecorderFailed');
	perform = original;
	const saved = expectOk(await recording.stop());
	expect(saved.blobId).toBe(parseBlobId(live.audioBlobId)!);
	expect(saved.blobId.endsWith('.wav')).toBe(true);
	await owner.close();
});

test('session registration captures the app ID before capture starts', async () => {
	const { owner } = setup();
	const recording = expectOk(await owner.value.start({}));
	expect(
		invoke.mock.calls.find(
			([name]) => name === 'register_recording_session',
		)?.[1]?.appId,
	).toBe('so.epicenter.test');
	expect(
		invoke.mock.calls.find(([name]) => name === 'start_recording')?.[1],
	).not.toHaveProperty('replica');
	expectOk(await recording.cancel());
	await owner.close();
});

test('lost start reply reconciles inside the original admitted start', async () => {
	const { owner, live } = setup();
	const original = perform;
	let starts = 0;
	perform = async (command, args) => {
		const result = await original(command, args);
		if (command === 'start_recording' && ++starts === 1)
			throw new Error('reply lost after acquisition');
		return result;
	};
	const recording = expectOk(await owner.value.start({}));
	expect(recording.id).toBe(live.audioBlobId);
	const requests = invoke.mock.calls.filter(
		([name]) => name === 'start_recording',
	);
	expect(requests).toHaveLength(1);
	expect(
		invoke.mock.calls.filter(([name]) => name === 'resolve_recording_start'),
	).toHaveLength(1);
	expectOk(await recording.cancel());
	await owner.close();
});

test('lost registration reply still closes the exact pending document', async () => {
	const { owner } = setup();
	const original = perform;
	perform = async (command, args) => {
		if (command === 'register_recording_session')
			throw new Error('registration reply lost');
		return original(command, args);
	};
	expect(expectErr(await owner.value.start({})).name).toBe('RecorderFailed');
	await owner.close();
	expect(invoke.mock.calls.map(([name]) => name)).toEqual([
        'recording_document_generation',
		'register_recording_session',
		'close_recording_session',
	]);
	expect(invoke.mock.calls[2]?.[1]?.sessionId).toEqual(
		invoke.mock.calls[1]?.[1]?.sessionId,
	);
});

test('stop returns only a saved blob and retries its exact lost response', async () => {
	const { owner, live } = setup();
	const recording = expectOk(await owner.value.start({}));
	const original = perform;
	let stops = 0;
	perform = async (command, args) => {
		const result = await original(command, args);
		if (command === 'stop_recording' && ++stops === 1)
			throw new Error('stop reply lost');
		return result;
	};
	expect(expectErr(await recording.stop()).name).toBe('RecorderFailed');
	const finished = expectOk(await recording.stop());
	expect(finished).toEqual({
		blobId: parseBlobId(live.audioBlobId)!,
		durationMs: 1000,
		byteLength: 96044,
	});
	expect(expectOk(await recording.stop())).toBe(finished);
	expect(
		invoke.mock.calls.filter(([name]) => name === 'stop_recording'),
	).toHaveLength(2);
	expect(
		invoke.mock.calls.some(([name]) => name === 'publish_recording_file'),
	).toBe(false);
	await owner.close();
});

test('concurrent stop and cancel cannot resolve the same capture twice', async () => {
	const { owner } = setup();
	const recording = expectOk(await owner.value.start({}));
	const pending = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const original = perform;
	perform = async (command, args) => {
		if (command === 'stop_recording') {
			entered.resolve();
			await pending.promise;
		}
		return original(command, args);
	};
	const stop = recording.stop();
	await entered.promise;
	expect(expectErr(await recording.stop()).name).toBe('NoActiveRecording');
	expect(expectErr(await recording.cancel()).name).toBe('NoActiveRecording');
	pending.resolve();
	expectOk(await stop);
	await owner.close();
});

test('lost cancel reply remains retryable and stale controls cannot cancel its successor', async () => {
	const { owner, live } = setup();
	const recording = expectOk(await owner.value.start({}));
	const original = perform;
	let cancellations = 0;
	perform = async (command, args) => {
		const result = await original(command, args);
		if (command === 'cancel_recording' && ++cancellations === 1)
			throw new Error('cancel reply lost');
		return result;
	};
	expect(expectErr(await recording.cancel()).name).toBe('RecorderFailed');
	expectOk(await recording.cancel());
	live.audioBlobId = generateBlobId('wav');
	const next = expectOk(await owner.value.start({}));
	expect(next.id).not.toBe(recording.id);
	expect(expectErr(await recording.cancel()).name).toBe('NoActiveRecording');
	expect(cancellations).toBe(2);
	expectOk(await next.cancel());
	await owner.close();
});

test('close during permission prevents late microphone acquisition', async () => {
	const { owner } = setup();
	const pending = Promise.withResolvers<string>();
	const entered = Promise.withResolvers<void>();
	const original = perform;
	perform = async (command, args) => {
		if (command === 'request_microphone_permission') {
			entered.resolve();
			return pending.promise;
		}
		return original(command, args);
	};
	const start = owner.value.start({});
	await entered.promise;
	const closing = owner.close();
	expect(owner.close()).toBe(closing);
	expect(() => owner.value.start({})).toThrow('closed');
	pending.resolve('granted');
	expect(expectErr(await start).name).toBe('NoActiveRecording');
	await closing;
	expect(invoke.mock.calls.some(([name]) => name === 'start_recording')).toBe(
		false,
	);
	expect(
		invoke.mock.calls.filter(([name]) => name === 'close_recording_session'),
	).toHaveLength(1);
});

test('close drains admitted native start and revokes its returned handle', async () => {
	const { owner } = setup();
	const pending = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const original = perform;
	perform = async (command, args) => {
		if (command === 'start_recording') {
			entered.resolve();
			await pending.promise;
		}
		return original(command, args);
	};
	const start = owner.value.start({});
	await entered.promise;
	const closing = owner.close();
	expect(
		invoke.mock.calls.some(([name]) => name === 'close_recording_session'),
	).toBe(false);
	pending.resolve();
	const recording = expectOk(await start);
	await closing;
	expect(() => recording.stop()).toThrow('closed');
	expect(invoke.mock.calls.at(-1)?.[0]).toBe('close_recording_session');
});

test('close drains admitted stop before retiring its native session', async () => {
	const { owner } = setup();
	const recording = expectOk(await owner.value.start({}));
	const pending = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const original = perform;
	perform = async (command, args) => {
		if (command === 'stop_recording') {
			entered.resolve();
			await pending.promise;
		}
		return original(command, args);
	};
	const stop = recording.stop();
	await entered.promise;
	const closing = owner.close();
	expect(
		invoke.mock.calls.some(([name]) => name === 'close_recording_session'),
	).toBe(false);
	pending.resolve();
	expectOk(await stop);
	await closing;
	expect(invoke.mock.calls.at(-1)?.[0]).toBe('close_recording_session');
});

test('level and ending events target only the held native identity', async () => {
	const { owner, live } = setup();
	const recording = expectOk(await owner.value.start({}));
	const levels: number[] = [];
	const endings: string[] = [];
	recording.onLevel((level) => levels.push(level));
	recording.onEnded((reason) => endings.push(reason));
	await Promise.resolve();
	listeners.get('mic-level')?.({ payload: { audioBlobId: 'other', level: 1 } });
	listeners.get('recording-ended-event')?.({
		payload: { audioBlobId: 'other', reason: 'streamFailed' },
	});
	expect(levels).toEqual([]);
	expect(endings).toEqual([]);
	listeners.get('mic-level')?.({
		payload: { audioBlobId: live.audioBlobId, level: 0.5 },
	});
	listeners.get('recording-ended-event')?.({
		payload: { audioBlobId: live.audioBlobId, reason: 'deviceDisconnected' },
	});
	listeners.get('recording-ended-event')?.({
		payload: { audioBlobId: live.audioBlobId, reason: 'streamFailed' },
	});
	expect(levels).toEqual([0.5]);
	expect(endings).toEqual(['deviceDisconnected']);
	expectOk(await recording.stop());
	await owner.close();
	expect(listeners.size).toBe(0);
});

test('close waits for late listener registration and its asynchronous release', async () => {
	const { owner } = setup();
	const registering = Promise.withResolvers<void>();
	const releasing = Promise.withResolvers<void>();
	registration = registering.promise;
	nativeUnlisten = releasing.promise;
	const recording = expectOk(await owner.value.start({}));
	recording.onLevel(() => {});
	let closed = false;
	const closing = owner.close().then(() => {
		closed = true;
	});
	registering.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(released).toContain('mic-level');
	expect(closed).toBe(false);
	releasing.resolve();
	await closing;
	expect(closed).toBe(true);
	expect(listeners.size).toBe(0);
});

test('failed listener release attempts every cleanup and rejects terminal close', async () => {
	const { owner } = setup();
	const recording = expectOk(await owner.value.start({}));
	recording.onLevel(() => {});
	recording.onEnded(() => {});
	unlistenFailure = new Error('unlisten failed');
	const closing = owner.close();
	await expect(closing).rejects.toThrow('cleanup failed');
	expect(released.toSorted()).toEqual(['mic-level', 'recording-ended-event']);
	expect(owner.close()).toBe(closing);
});

test('failed native close rejects after listener cleanup and is terminal', async () => {
	const { owner } = setup();
	const recording = expectOk(await owner.value.start({}));
	recording.onLevel(() => {});
	const original = perform;
	perform = async (command, args) => {
		if (command === 'close_recording_session')
			throw new Error('native close failed');
		return original(command, args);
	};
	const closing = owner.close();
	await expect(closing).rejects.toThrow('cleanup failed');
	expect(released).toContain('mic-level');
	expect(owner.close()).toBe(closing);
});

test.each([
	['PermissionDenied', 'MicrophonePermissionDenied'],
	['NoInputDevice', 'NoInputDevice'],
	['Busy', 'AlreadyRecording'],
	['Failed', 'RecorderFailed'],
] as const)('native %s start failure remains %s', async (native, expected) => {
	const { owner } = setup();
	const original = perform;
	perform = async (command, args) => {
		if (command === 'start_recording')
			throw { name: native, message: 'native refusal' };
		return original(command, args);
	};
	expect(expectErr(await owner.value.start({})).name).toBe(expected);
	await owner.close();
});

test('readiness fences retained operations synchronously while close still cleans up', async () => {
	let usable = true;
	const { owner } = setup({
		assertUsable() {
			if (!usable) throw new Error('not ready');
		},
	});
	const recording = expectOk(await owner.value.start({}));
	const stop = recording.stop;
	usable = false;
	expect(() => stop()).toThrow('not ready');
	expect(() => recording.onLevel(() => {})).toThrow('not ready');
	await owner.close();
	expect(invoke.mock.calls.at(-1)?.[0]).toBe('close_recording_session');
});

test('a missed ending is reconciled after the native listener registers', async () => {
	const { owner, live } = setup();
	const recording = expectOk(await owner.value.start({}));
	const registered = Promise.withResolvers<void>();
	registration = registered.promise;
	const ended = Promise.withResolvers<string>();
	recording.onEnded((reason) => ended.resolve(reason));
	live.endedReason = 'deviceDisconnected';
	registered.resolve();
	expect(await ended.promise).toBe('deviceDisconnected');
	expect(recording.endedReason).toBe('deviceDisconnected');
	expectOk(await recording.stop());
	await owner.close();
});

test('current reconciles lost cancellation but preserves a retryable lost stop', async () => {
	const { owner, live } = setup();
	const first = expectOk(await owner.value.start({}));
	const original = perform;
	let lost = 'cancel_recording';
	perform = async (command, args) => {
		const result = await original(command, args);
		if (command === lost) {
			lost = '';
			throw new Error('native reply lost');
		}
		return result;
	};
	expect(expectErr(await first.cancel()).name).toBe('RecorderFailed');
	expect(expectOk(await owner.value.current())).toBeNull();
	live.audioBlobId = generateBlobId('wav');
	const second = expectOk(await owner.value.start({}));
	lost = 'stop_recording';
	expect(expectErr(await second.stop()).name).toBe('RecorderFailed');
	expect(expectOk(await owner.value.current())).toBe(second);
	expectOk(await second.stop());
	await owner.close();
});

test('unconfirmed start preserves its original device and request until retry resolves it', async () => {
	const { owner, live } = setup();
	const original = perform;
	let starts = 0;
	perform = async (command, args) => {
		if (command === 'resolve_recording_start')
			throw new Error('reconciliation unavailable');
		const result = await original(command, args);
		if (command === 'start_recording' && ++starts === 1)
			throw new Error('start reply lost');
		return result;
	};
	expect(
		expectErr(
			await owner.value.start({
				selectedDeviceId: asDeviceIdentifier('original'),
			}),
		).name,
	).toBe('StartUnconfirmed');
	const recording = expectOk(
		await owner.value.start({
			selectedDeviceId: asDeviceIdentifier('changed'),
		}),
	);
	expect(recording.id).toBe(live.audioBlobId);
	const requests = invoke.mock.calls.filter(
		([name]) => name === 'start_recording',
	);
	expect(requests).toHaveLength(2);
	expect(requests[1]?.[1]).toEqual(requests[0]?.[1]);
	expect(requests[1]?.[1]?.deviceIdentifier).toBe('original');
	expectOk(await recording.cancel());
	await owner.close();
});

test('current exposes an unconfirmed native start for exact cancellation', async () => {
	const { owner, live } = setup();
	const original = perform;
	let failCurrent = true;
	perform = async (command, args) => {
		if (command === 'resolve_recording_start' && failCurrent)
			throw new Error('reconciliation unavailable');
		const result = await original(command, args);
		if (command === 'start_recording') throw new Error('start reply lost');
		return result;
	};
	expect(expectErr(await owner.value.start({})).name).toBe('StartUnconfirmed');
	failCurrent = false;
	const recording = expectOk(await owner.value.current());
	expect(recording?.id).toBe(live.audioBlobId);
	expectOk(await recording!.cancel());
	expect(invoke.mock.calls.at(-1)?.[1]?.audioBlobId).toBe(live.audioBlobId);
	await owner.close();
});

for (const reply of ['success', 'failure'] as const) {
	for (const resolution of ['live', 'cancelled', 'absent'] as const) {
		test(`concurrent current ${resolution} owns resolution before retry ${reply}`, async () => {
			const { owner, live } = setup();
			const original = perform;
			perform = async (command, args) => {
				if (command === 'resolve_recording_start')
					throw new Error('resolve lost');
				const result = await original(command, args);
				if (command === 'start_recording') throw new Error('start lost');
				return result;
			};
			expect(expectErr(await owner.value.start({})).name).toBe(
				'StartUnconfirmed',
			);
			const entered = Promise.withResolvers<void>();
			const response = Promise.withResolvers<NativeRecording>();
			perform = async (command, args) => {
				if (command === 'start_recording') {
					entered.resolve();
					return response.promise;
				}
				if (command === 'resolve_recording_start' && resolution === 'absent')
					return null;
				return original(command, args);
			};
			const retry = owner.value.start({});
			await entered.promise;
			const recording = expectOk(await owner.value.current());
			if (resolution === 'absent') expect(recording).toBeNull();
			else expect(recording?.id).toBe(live.audioBlobId);
			if (resolution === 'cancelled') expectOk(await recording!.cancel());
			if (reply === 'success') response.resolve({ ...live });
			else response.reject(new Error('retry response lost'));
			if (resolution === 'live') {
				expect(expectOk(await retry)).toBe(recording!);
				expectOk(await recording!.cancel());
			} else expect(expectErr(await retry).name).toBe('NoActiveRecording');
			perform = original;
			live.audioBlobId = generateBlobId('wav');
			const successor = expectOk(await owner.value.start({}));
			expect(expectOk(await owner.value.current())).toBe(successor);
			expectOk(await successor.cancel());
			await owner.close();
		});
	}
}

test('late current cannot replace a retry handle or resurrect a cancelled capture', async () => {
	const { owner, live } = setup();
	const original = perform;
	perform = async (command, args) => {
		if (command === 'resolve_recording_start') throw new Error('resolve lost');
		const result = await original(command, args);
		if (command === 'start_recording') throw new Error('start lost');
		return result;
	};
	expect(expectErr(await owner.value.start({})).name).toBe('StartUnconfirmed');
	const entered = Promise.withResolvers<void>();
	const response = Promise.withResolvers<NativeRecording>();
	perform = async (command, args) => {
		if (command === 'resolve_recording_start') {
			entered.resolve();
			return response.promise;
		}
		return original(command, args);
	};
	const current = owner.value.current();
	await entered.promise;
	const first = expectOk(await owner.value.start({}));
	const stale = { ...live };
	expectOk(await first.cancel());
	live.audioBlobId = generateBlobId('wav');
	const successor = expectOk(await owner.value.start({}));
	response.resolve(stale);
	expect(expectOk(await current)).toBe(successor);
	expect(expectOk(await owner.value.current())).toBe(successor);
	expectOk(await successor.cancel());
	await owner.close();
});

test('confirmed absence clears an unresolved start before a newly selected device', async () => {
	const { owner } = setup();
	const original = perform;
	perform = async (command, args) => {
		if (command === 'start_recording' || command === 'resolve_recording_start')
			throw new Error('IPC unavailable');
		return original(command, args);
	};
	expect(
		expectErr(
			await owner.value.start({
				selectedDeviceId: asDeviceIdentifier('original'),
			}),
		).name,
	).toBe('StartUnconfirmed');
	perform = original;
	expect(expectOk(await owner.value.current())).toBeNull();
	const recording = expectOk(
		await owner.value.start({ selectedDeviceId: asDeviceIdentifier('new') }),
	);
	const requests = invoke.mock.calls.filter(
		([name]) => name === 'start_recording',
	);
	expect(requests[1]?.[1]?.requestId).not.toBe(requests[0]?.[1]?.requestId);
	expect(requests[1]?.[1]?.deviceIdentifier).toBe('new');
	expectOk(await recording.cancel());
	await owner.close();
});

test.each([
	'CaptureLost',
	'NotRecording',
] as const)('definitive native stop %s releases held controls and listeners', async (failure) => {
	const { owner, live } = setup();
	const original = perform;
	const recording = expectOk(await owner.value.start({}));
	recording.onLevel(() => {});
	perform = async (command, args) => {
		const result = await original(command, args);
		if (command === 'stop_recording')
			throw { name: failure, message: 'capture consumed' };
		return result;
	};
	expect(expectErr(await recording.stop()).name).toBe(
		failure === 'CaptureLost' ? 'CaptureLost' : 'NoActiveRecording',
	);
	expect(expectOk(await owner.value.current())).toBeNull();
	expect(released).toContain('mic-level');
	live.audioBlobId = generateBlobId('wav');
	const next = expectOk(await owner.value.start({}));
	expect(next.id).not.toBe(recording.id);
	expect(expectErr(await recording.stop()).name).toBe('NoActiveRecording');
	expectOk(await next.cancel());
	await owner.close();
});
