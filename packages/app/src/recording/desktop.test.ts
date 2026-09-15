/**
 * Native recording transport tests.
 * Pins captured destinations, recovered owner checks, one-shot resolution,
 * listener cleanup, and typed IPC failures without opening a microphone.
 */
import { expect, mock, test } from 'bun:test';
import { generateBlobId } from '@epicenter/blobs';
import { attachmentEngineOf } from '@epicenter/data/store';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { NativeRecording, RecordingOptions } from '../recorder.js';
import { createRecordingAttachment } from './attachment.test-support.js';

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

async function setup(options: RecordingOptions = {}) {
	invoke.mockClear();
	registration = undefined;
	unlistenFailure = undefined;
	nativeUnlisten = undefined;
	listeners.clear();
	released.length = 0;
	const { into, table, blobStore } = await createRecordingAttachment({
		appId: 'so.epicenter.test',
		replica: { library: 'local' },
	});
	const live: NativeRecording = {
		audioBlobId: generateBlobId(),
		attachment: {
			tableName: into.tableName,
			rowId: into.rowId,
			generation: null,
		},
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
				if ((await blobStore.stat(attachmentEngineOf(into).storageId)).error)
					expectOk(
						await blobStore.put(
							attachmentEngineOf(into).storageId,
							new Blob(['native'], { type: 'audio/wav' }),
						),
					);
				return {
					audioBlobId: live.audioBlobId,
					durationMs: 100,
					byteLength: 3200,
				};
			case 'release_recording':
			case 'retire_recording':
			case 'acknowledge_recording':
			case 'cancel_recording':
				return;
			case 'enumerate_recording_devices':
				return ['mic'];
			default:
				throw new Error(`Unexpected command: ${command}`);
		}
	};
	return {
		into,
		table,
		blobStore,
		owner: createDesktopRecording(
			'so.epicenter.test',
			{ library: 'local' },
			{
				resolveAttachment: (_tableName, rowId) => table.attachment(rowId),
				...options,
			},
		),
		live,
	};
}

test('construction is inert and start captures destination before permission completes', async () => {
	const { live } = await setup();
	const accountDestination = {
		appId: 'so.epicenter.test',
		replica: {
			library: 'personal' as const,
			account: { authorityId: 'first', principalId: 'alice' },
		},
	};
	const { into } = await createRecordingAttachment(accountDestination);
	live.audioBlobId = generateBlobId();
	live.attachment = {
		tableName: into.tableName,
		rowId: into.rowId,
		generation: null,
	};
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
		{},
	);
	account.authorityId = 'second';
	const started = owner.value.start({ into });
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
	const { owner, live } = await setup();
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
	const { into, owner } = await setup();
	const recording = expectOk(await owner.value.start({ into }));
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
	const { into, owner, live } = await setup();
	const recording = expectOk(await owner.value.start({ into }));
	live.endedReason = 'deviceDisconnected';
	const ended = Promise.withResolvers<string>();
	recording.onEnded((reason) => ended.resolve(reason));
	expect(await ended.promise).toBe('deviceDisconnected');
	expect(recording.endedReason).toBe('deviceDisconnected');
	expectOk(await recording.stop());
	expect(released).toContain('recording-ended-event');
});

test('native permission errors retain their actionable category', async () => {
	const { into, owner } = await setup();
	perform = async () => {
		throw { name: 'PermissionDenied', message: 'Denied' };
	};
	expect(expectErr(await owner.value.start({ into })).name).toBe(
		'MicrophonePermissionDenied',
	);
	expect(invoke).toHaveBeenCalledTimes(1);
});

test('current refreshes the held session after capture ends without a subscriber', async () => {
	const { into, owner, live } = await setup();
	const recording = expectOk(await owner.value.start({ into }));
	live.endedReason = 'deviceDisconnected';
	expect(expectOk(await owner.value.current())).toBe(recording);
	expect(recording.endedReason).toBe('deviceDisconnected');
	expectOk(await recording.cancel());
});

test('close waits for native startup and preserves the late capture', async () => {
	const { into, owner } = await setup();
	const permission = Promise.withResolvers<string>();
	const original = perform;
	perform = (command, args) =>
		command === 'request_microphone_permission'
			? permission.promise
			: original(command, args);
	const starting = owner.value.start({ into });
	const closing = owner.close();
	expect(owner.close()).toBe(closing);
	expect(() => owner.value.start({ into })).toThrow('closed');
	expect(() => owner.value.current()).toThrow('closed');
	expect(() => owner.value.enumerateDevices()).toThrow('closed');
	permission.resolve('granted');
	const recording = expectOk(await starting);
	await closing;
	expect(
		invoke.mock.calls.filter(([command]) => command === 'release_recording'),
	).toHaveLength(1);
	expect(() => recording.stop()).toThrow('closed');
	expect(() => recording.cancel()).toThrow('closed');
	expect(() => recording.onLevel(() => {})).toThrow('closed');
	expect(() => recording.onEnded(() => {})).toThrow('closed');
});

test('close drains an admitted native stop before recovery or cancellation', async () => {
	const { into, owner } = await setup();
	const recording = expectOk(await owner.value.start({ into }));
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

test('refused recovery performs no native calls but own capture is still released', async () => {
	const { into } = await setup();
	const refused = createDesktopRecording(
		'so.epicenter.test',
		{ library: 'local' },
		{
			canRecover: () => false,
		},
	);
	await refused.close();
	expect(invoke).not.toHaveBeenCalled();
	const owner = createDesktopRecording(
		'so.epicenter.test',
		{ library: 'local' },
		{
			canRecover: () => false,
		},
	);
	expectOk(await owner.value.start({ into }));
	await owner.close();
	expect(
		invoke.mock.calls.filter(([command]) => command === 'release_recording'),
	).toHaveLength(1);
});

test('close waits for late listener registration and unlistens before completing', async () => {
	const { into, owner } = await setup();
	const pending = Promise.withResolvers<void>();
	registration = pending.promise;
	const recording = expectOk(await owner.value.start({ into }));
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

test('failed native release rejects the same terminal close promise', async () => {
	const { into, owner } = await setup();
	expectOk(await owner.value.start({ into }));
	const original = perform;
	perform = async (command, args) => {
		if (command === 'release_recording') throw new Error('cancel failed');
		return original(command, args);
	};
	const closing = owner.close();
	await expect(closing).rejects.toMatchObject({ name: 'RecorderFailed' });
	expect(owner.close()).toBe(closing);
});

test('failed unlisten rejects close after attempting every listener release', async () => {
	const { into, owner } = await setup();
	const recording = expectOk(await owner.value.start({ into }));
	recording.onLevel(() => {});
	recording.onEnded(() => {});
	unlistenFailure = new Error('unlisten failed');
	await expect(owner.close()).rejects.toThrow('cleanup failed');
	expect(released.toSorted()).toEqual(['mic-level', 'recording-ended-event']);
});

test('native readiness checks retained operations synchronously and close bypasses readiness', async () => {
	const { into } = await setup();
	let usable = false;
	const owner = createDesktopRecording(
		'so.epicenter.test',
		{ library: 'local' },
		{
			assertUsable() {
				if (!usable) throw new Error('not ready');
			},
		},
	);
	const start = owner.value.start;
	expect(() => start({ into })).toThrow('not ready');
	usable = true;
	const recording = expectOk(await start({ into }));
	const cancel = recording.cancel;
	usable = false;
	expect(() => cancel()).toThrow('not ready');
	expect(() => recording.onLevel(() => {})).toThrow('not ready');
	await owner.close();
});

test('close awaits the promise returned by native unlisten despite its void type', async () => {
	const { into, owner } = await setup();
	const pending = Promise.withResolvers<void>();
	nativeUnlisten = pending.promise;
	const recording = expectOk(await owner.value.start({ into }));
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
	const { owner } = await setup();
	await owner.close();
	expect(invoke).not.toHaveBeenCalled();
});

test('authorized close ignores capture owned by another destination', async () => {
	const { live } = await setup();
	live.destination.appId = 'so.epicenter.another';
	const owner = createDesktopRecording(
		'so.epicenter.test',
		{ library: 'local' },
		{
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
	const { into, owner } = await setup();
	expectOk(await owner.value.start({ into }));
	const original = perform;
	perform = async (command, args) => {
		if (command === 'release_recording') throw { name: 'NotRecording' };
		return original(command, args);
	};
	await owner.close();
	expect(
		invoke.mock.calls.filter(([command]) => command === 'release_recording'),
	).toHaveLength(1);
});

test('cancel retains its native failure when listener release also fails', async () => {
	const { into, owner } = await setup();
	const recording = expectOk(await owner.value.start({ into }));
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

test('recovery binds the original row and completes its already-published local bytes', async () => {
	const { owner, into, table, blobStore } = await setup();
	const id = attachmentEngineOf(into).storageId;
	expectOk(
		await blobStore.put(id, new Blob(['recovered'], { type: 'audio/wav' })),
	);
	const recovered = expectOk(await owner.value.current());
	expect(recovered?.into.rowId).toBe(into.rowId);
	expectOk(await recovered!.stop());
	expect(table.get(into.rowId)?.audio).toBe('audio/wav');
	expect(await expectOk(await into.read()).text()).toBe('recovered');
	expect(
		invoke.mock.calls.some(([command]) => command === 'acknowledge_recording'),
	).toBe(true);
});

test('deleting a captured row refuses completion and leaves the next row empty', async () => {
	const { owner, into, table } = await setup();
	const recording = expectOk(await owner.value.start({ into }));
	table.delete(into.rowId);
	const next = table.create({ audio: null });
	expect(expectErr(await recording.stop())).toMatchObject({
		name: 'Unavailable',
		reason: 'row-absent',
	});
	expect(table.get(into.rowId)).toBeUndefined();
	expect(table.get(next.id)?.audio).toBeNull();
	expect(
		invoke.mock.calls.some(([command]) => command === 'acknowledge_recording'),
	).toBe(false);
});

test.each([
	false,
	true,
])('cancelling completed audio after a lost acknowledgment delegates preservation to native cleanup, deleted row=%s', async (deleted) => {
	const { owner, into, table, blobStore } = await setup();
	const recording = expectOk(await owner.value.start({ into }));
	const original = perform;
	perform = async (command, args) => {
		if (command === 'acknowledge_recording')
			throw new Error('lost acknowledgment');
		return original(command, args);
	};
	expect(expectErr(await recording.stop()).name).toBe('RecorderFailed');
	expect(table.get(into.rowId)?.audio).toBe('audio/wav');
	if (deleted) table.delete(into.rowId);
	const recovered = expectOk(await owner.value.current());
	expect(recovered).toBe(recording);
	invoke.mockClear();
	expectOk(await recovered!.cancel());
	expect(
		invoke.mock.calls.some(([command]) => command === 'cancel_recording'),
	).toBe(true);
	expect(
		invoke.mock.calls.some(([command]) => command === 'acknowledge_recording'),
	).toBe(false);
	expect(
		await expectOk(
			await blobStore.get(attachmentEngineOf(into).storageId),
		).text(),
	).toBe('native');
	if (deleted) expect(table.get(into.rowId)).toBeUndefined();
	await owner.close();
});

test('failed cancellation remains retryable on the recovered session and permits its successor', async () => {
	const { owner, into, table, live } = await setup();
	const recording = expectOk(await owner.value.start({ into }));
	const original = perform;
	let cancellations = 0;
	perform = async (command, args) => {
		if (command === 'cancel_recording' && ++cancellations === 1)
			throw new Error('temporary IPC failure');
		return original(command, args);
	};
	expect(expectErr(await recording.cancel()).name).toBe('RecorderFailed');
	const recovered = expectOk(await owner.value.current());
	expect(recovered).toBe(recording);
	expectOk(await recovered!.cancel());
	expect(cancellations).toBe(2);
	const nextRow = table.create({ audio: null });
	const nextInto = table.attachment(nextRow.id);
	live.audioBlobId = generateBlobId();
	live.attachment.rowId = nextRow.id;
	const next = expectOk(await owner.value.start({ into: nextInto }));
	expect(next.into.rowId).toBe(nextRow.id);
	expect(expectErr(await recording.cancel()).name).toBe('NoActiveRecording');
	expect(cancellations).toBe(2);
	expectOk(await next.cancel());
	await owner.close();
});

test('close preserves an undiscovered native capture without resolving a closed row handle', async () => {
	await setup();
	const owner = createDesktopRecording(
		'so.epicenter.test',
		{ library: 'local' },
		{
			canRecover: () => true,
			resolveAttachment() {
				throw new Error('the document is already closed');
			},
		},
	);
	await owner.close();
	expect(invoke.mock.calls.map(([command]) => command)).toEqual([
		'current_recording',
		'release_recording',
	]);
});

test('lost cancellation response can reconcile absence and close without a capture journal', async () => {
	const { owner, into } = await setup();
	const recording = expectOk(await owner.value.start({ into }));
	const original = perform;
	let nativePresent = true;
	perform = async (command, args) => {
		if (command === 'cancel_recording') {
			nativePresent = false;
			throw new Error('response lost after native cancellation');
		}
		if (command === 'current_recording' && !nativePresent) return null;
		// Release is a no-op after the exact session and its journal are gone.
		return original(command, args);
	};
	expect(expectErr(await recording.cancel()).name).toBe('RecorderFailed');
	expect(expectOk(await owner.value.current())).toBeNull();
	await owner.close();
	expect(invoke.mock.calls.at(-1)).toEqual([
		'release_recording',
		{
			audioBlobId: recording.id,
			destination: {
				appId: 'so.epicenter.test',
				replica: { library: 'local' },
			},
		},
	]);
});

test('retirement of saved but unacknowledged capture preserves published bytes', async () => {
	let retired = false;
	const { owner, into, blobStore } = await setup({ isRetired: () => retired });
	const recording = expectOk(await owner.value.start({ into }));
	const original = perform;
	perform = async (command, args) => {
		if (command === 'acknowledge_recording')
			throw new Error('lost acknowledgment');
		return original(command, args);
	};
	expect(expectErr(await recording.stop()).name).toBe('RecorderFailed');
	expectOk(await into.read());
	retired = true;
	await owner.close();
	expect(
		invoke.mock.calls.some(([command]) => command === 'retire_recording'),
	).toBe(true);
	expect(
		invoke.mock.calls.some(([command]) => command === 'cancel_recording'),
	).toBe(false);
	expect(
		await expectOk(
			await blobStore.get(attachmentEngineOf(into).storageId),
		).text(),
	).toBe('native');
});

test('an opened generation retires an obsolete journal without resolving deleted rows or removed tables', async () => {
	const { live } = await setup();
	const replica = {
		library: 'personal' as const,
		account: { authorityId: 'authority', principalId: asPrincipalId('alice') },
	};
	live.destination.replica = replica;
	live.attachment.generation = 3;
	live.attachment.tableName = 'removed-table';
	let journal: NativeRecording | null = live;
	const original = perform;
	perform = async (command, args) => {
		if (command === 'current_recording') return journal;
		if (command === 'retire_recording') {
			journal = null;
			return;
		}
		return original(command, args);
	};
	const owner = createDesktopRecording('so.epicenter.test', replica, {
		generation: () => 4,
		resolveAttachment() {
			throw new Error('removed table must not be resolved');
		},
	});
	expect(expectOk(await owner.value.current())).toBeNull();
	expect(expectOk(await owner.value.current())).toBeNull();
	expect(
		invoke.mock.calls.filter(([command]) => command === 'retire_recording'),
	).toHaveLength(1);
	expect(
		invoke.mock.calls.some(([command]) => command === 'cancel_recording'),
	).toBe(false);
});

test.each([
	undefined,
	null,
	2,
	3,
])('unknown, older, or matching opened generation %s preserves an unresolved journal', async (generation) => {
	const { live } = await setup();
	const replica = {
		library: 'personal' as const,
		account: { authorityId: 'authority', principalId: asPrincipalId('alice') },
	};
	live.destination.replica = replica;
	live.attachment.generation = 3;
	const owner = createDesktopRecording('so.epicenter.test', replica, {
		generation: () => generation,
		resolveAttachment() {
			throw new Error('table unavailable');
		},
	});
	expect(expectErr(await owner.value.current()).name).toBe('RecorderFailed');
	expect(invoke.mock.calls.map(([command]) => command)).toEqual([
		'current_recording',
	]);
});

test('same-generation deletion remains an explicit unavailable row and never authorizes retirement', async () => {
	const { owner, table, into } = await setup({ generation: () => null });
	table.delete(into.rowId);
	const recovered = expectOk(await owner.value.current());
	expect(expectErr(await recovered!.stop())).toMatchObject({
		name: 'Unavailable',
		reason: 'row-absent',
	});
	expect(
		invoke.mock.calls.some(([command]) => command === 'retire_recording'),
	).toBe(false);
	expect(
		invoke.mock.calls.some(([command]) => command === 'cancel_recording'),
	).toBe(false);
});

test('a failed current query cannot authorize retiring staged audio', async () => {
	const { owner } = await setup({ generation: () => 4 });
	perform = async () => {
		throw new Error('IPC unavailable');
	};
	expect(expectErr(await owner.value.current()).name).toBe('RecorderFailed');
	expect(invoke.mock.calls.map(([command]) => command)).toEqual([
		'current_recording',
	]);
});
