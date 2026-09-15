/**
 * Browser recording lifecycle tests.
 * Verifies permission races, destination capture, final data publication, and
 * failed capture recovery through browser API fakes and real IndexedDB storage.
 */
import { afterEach, expect, test } from 'bun:test';
import { BlobStoreError } from '@epicenter/blobs';
import { createBrowserBlobStore } from '@epicenter/blobs/browser';
import { attachmentEngineOf } from '@epicenter/data/store';
import { asPrincipalId } from '@epicenter/principal';
import { IDBFactory } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createRecordingAttachment } from './attachment.test-support.js';
import { createBrowserRecording } from './browser.js';

const originals = new Map<string, PropertyDescriptor | undefined>();
function replaceGlobal(key: string, value: unknown) {
	originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, value });
}
afterEach(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function setup({
	deferPermission = false,
	failStart = false,
	stopBeforeStart = false,
} = {}) {
	class Track extends EventTarget {
		stops = 0;
		stop() {
			this.stops++;
		}
		getSettings() {
			return { deviceId: 'mic' };
		}
	}
	const tracks: Track[] = [];
	const recorders: Recorder[] = [];
	const permission = Promise.withResolvers<void>();
	const permissionEntered = Promise.withResolvers<void>();
	let acquisitions = 0;
	class Recorder extends EventTarget {
		state = 'inactive';
		mimeType = 'audio/webm';
		constructor() {
			super();
			recorders.push(this);
		}
		start() {
			this.state = 'recording';
			queueMicrotask(() => {
				if (stopBeforeStart) this.stop();
				else if (failStart) this.fail();
				else this.dispatchEvent(new Event('start'));
			});
		}
		data(text: string) {
			this.dispatchEvent(
				Object.assign(new Event('dataavailable'), {
					data: new Blob([text], { type: this.mimeType }),
				}),
			);
		}
		stop() {
			this.state = 'inactive';
			queueMicrotask(() => {
				this.data('final');
				this.dispatchEvent(new Event('stop'));
			});
		}
		fail() {
			this.state = 'inactive';
			this.dispatchEvent(new Event('error'));
			queueMicrotask(() => {
				this.data('saved');
				this.dispatchEvent(new Event('stop'));
			});
		}
	}
	replaceGlobal('indexedDB', new IDBFactory());
	replaceGlobal('MediaRecorder', Recorder);
	replaceGlobal('navigator', {
		locks: {
			request: async (
				_name: string,
				_options: unknown,
				callback: (lock: object) => unknown,
			) => callback({}),
		},
		mediaDevices: {
			async getUserMedia() {
				acquisitions++;
				permissionEntered.resolve();
				if (deferPermission) await permission.promise;
				const track = new Track();
				tracks.push(track);
				return { getTracks: () => [track], getAudioTracks: () => [track] };
			},
		},
	});
	const appId = `test.${crypto.randomUUID()}`;
	const local = createBrowserBlobStore({
		appId,
		replica: { library: 'local' },
	});
	const attachment = await createRecordingAttachment({
		appId,
		replica: { library: 'local' },
		local,
	});
	return {
		...attachment,
		owner: createBrowserRecording(appId, { library: 'local' }, {}),
		appId,
		tracks,
		recorders,
		permission,
		permissionEntered,
		acquisitions: () => acquisitions,
	};
}

test('foreign application and library attachments are refused before microphone acquisition', async () => {
	const { owner, appId, acquisitions, into } = await setup();
	for (const destination of [
		{ appId: 'so.epicenter.other', replica: { library: 'local' as const } },
		{
			appId,
			replica: {
				library: 'personal' as const,
				account: { authorityId: 'server', principalId: 'alice' },
			},
		},
	]) {
		const foreign = await createRecordingAttachment(destination);
		expect(
			expectErr(await owner.value.start({ into: foreign.into })).name,
		).toBe('RecorderFailed');
		expect(acquisitions()).toBe(0);
	}
	const recording = expectOk(await owner.value.start({ into }));
	expect(acquisitions()).toBe(1);
	expectOk(await recording.cancel());
	await owner.close();
});

test('account capture refuses another authority, principal, or library', async () => {
	const { appId, acquisitions } = await setup();
	const account = {
		authorityId: 'server',
		principalId: asPrincipalId('alice'),
	};
	const owner = createBrowserRecording(
		appId,
		{ library: 'personal', account },
		{},
	);
	for (const replica of [
		{
			library: 'personal' as const,
			account: { ...account, authorityId: 'other' },
		},
		{
			library: 'personal' as const,
			account: { ...account, principalId: 'bob' },
		},
		{ library: 'shared' as const, account },
		{ library: 'local' as const },
	]) {
		const { into } = await createRecordingAttachment({ appId, replica });
		expect(expectErr(await owner.value.start({ into })).name).toBe(
			'RecorderFailed',
		);
	}
	expect(acquisitions()).toBe(0);
	await owner.close();
});

test('construction is inert and pending permission excludes competing starts', async () => {
	const { into, owner, acquisitions, permission, permissionEntered, tracks } =
		await setup({
			deferPermission: true,
		});
	expect(acquisitions()).toBe(0);
	const pending = owner.value.start({ into });
	expect(expectErr(await owner.value.start({ into })).name).toBe(
		'AlreadyRecording',
	);
	expect(expectErr(await owner.value.current()).name).toBe('AlreadyRecording');
	await permissionEntered.promise;
	expect(acquisitions()).toBe(1);
	permission.resolve();
	const recording = expectOk(await pending);
	expectOk(await recording.cancel());
	expect(tracks[0]?.stops).toBeGreaterThan(0);
});

test('stop stores final data in the captured account even when the input object changes', async () => {
	const { appId, permission, recorders } = await setup({
		deferPermission: true,
	});
	const replica = {
		library: 'personal' as const,
		account: { authorityId: 'first', principalId: asPrincipalId('alice') },
	};
	const { into } = await createRecordingAttachment({
		appId,
		replica,
		local: createBrowserBlobStore({ appId, replica }),
	});
	const account = replica.account;
	const owner = createBrowserRecording(appId, replica, {});
	account.authorityId = 'second';
	const pending = owner.value.start({ into });
	permission.resolve();
	const recording = expectOk(await pending);
	expect(Reflect.set(recording, 'replica', { library: 'local' })).toBe(false);
	expect(expectOk(await owner.value.current())).toBe(recording);
	recorders[0]?.data('first');
	expectOk(await recording.stop());
	const store = createBrowserBlobStore({
		appId,
		replica: {
			library: 'personal' as const,
			account: { authorityId: 'first', principalId: account.principalId },
		},
	});
	expect(
		await expectOk(await store.get(attachmentEngineOf(into).storageId)).text(),
	).toBe('firstfinal');
	expect(expectOk(await owner.value.current())).toBeNull();
});

test('stop publishes through the supplied store when its namespace differs from recording identity', async () => {
	const { appId } = await setup();
	const local = createBrowserBlobStore({
		appId: `supplied.${crypto.randomUUID()}`,
		replica: { library: 'local' as const },
	});
	const { into } = await createRecordingAttachment({
		appId,
		replica: { library: 'local' },
		local,
	});
	const owner = createBrowserRecording(appId, { library: 'local' }, {});
	const recording = expectOk(await owner.value.start({ into }));
	expectOk(await recording.stop());
	expect(
		await expectOk(await local.get(attachmentEngineOf(into).storageId)).text(),
	).toBe('final');
	const identityStore = createBrowserBlobStore({
		appId,
		replica: { library: 'local' as const },
	});
	expect(
		expectErr(await identityStore.get(attachmentEngineOf(into).storageId)).name,
	).toBe('BlobNotFound');
	await owner.close();
});

test('cancel discards bytes and a stale session cannot stop its successor', async () => {
	const { into, owner, appId, recorders } = await setup();
	const first = expectOk(await owner.value.start({ into }));
	expectOk(await first.cancel());
	const second = expectOk(await owner.value.start({ into }));
	expect(expectErr(await first.stop()).name).toBe('NoActiveRecording');
	expect(recorders[1]?.state).toBe('recording');
	const store = createBrowserBlobStore({
		appId,
		replica: { library: 'local' as const },
	});
	expect(
		expectErr(await store.get(attachmentEngineOf(into).storageId)).name,
	).toBe('BlobNotFound');
	expectOk(await second.cancel());
});

test('an asynchronous start error releases capture and permits another acquisition', async () => {
	const { into, owner, tracks, acquisitions } = await setup({
		failStart: true,
	});
	expect(expectErr(await owner.value.start({ into })).name).toBe(
		'RecorderFailed',
	);
	expect(tracks[0]?.stops).toBeGreaterThan(0);
	expect(expectErr(await owner.value.start({ into })).name).toBe(
		'RecorderFailed',
	);
	expect(acquisitions()).toBe(2);
});

test('capture error preserves its final bytes for stop and reports ended once', async () => {
	const { into, owner, appId, recorders, tracks } = await setup();
	const recording = expectOk(await owner.value.start({ into }));
	const reasons: string[] = [];
	recording.onEnded((reason) => reasons.push(reason));
	recorders[0]?.data('before');
	recorders[0]?.fail();
	expectOk(await recording.stop());
	expect(reasons).toEqual(['streamFailed']);
	expect(tracks[0]?.stops).toBeGreaterThan(0);
	const store = createBrowserBlobStore({
		appId,
		replica: { library: 'local' as const },
	});
	expect(
		await expectOk(await store.get(attachmentEngineOf(into).storageId)).text(),
	).toBe('beforesaved');
});

test('disconnected device remains resolvable and concurrent stop cannot publish twice', async () => {
	const { into, owner, tracks } = await setup();
	const recording = expectOk(await owner.value.start({ into }));
	tracks[0]?.dispatchEvent(new Event('ended'));
	expect(recording.endedReason).toBe('deviceDisconnected');
	const stopped = recording.stop();
	expect(expectErr(await recording.cancel()).name).toBe('NoActiveRecording');
	expectOk(await stopped);
});

test('late ended subscription delivers once and an unsubscribed listener is skipped', async () => {
	const { into, owner, tracks } = await setup();
	const recording = expectOk(await owner.value.start({ into }));
	tracks[0]?.dispatchEvent(new Event('ended'));
	const reasons: string[] = [];
	recording.onEnded((reason) => reasons.push(reason));
	const off = recording.onEnded(() => reasons.push('removed'));
	off();
	await Promise.resolve();
	expect(reasons).toEqual(['deviceDisconnected']);
	expectOk(await recording.cancel());
});

test('failed publication retains capture chunks for retry in the same row', async () => {
	const { into, owner, blobStore, tracks } = await setup();
	const put = blobStore.put;
	const recording = expectOk(await owner.value.start({ into }));
	blobStore.put = async (id) =>
		BlobStoreError.BlobStoreFailed({ id, cause: 'disk full' });
	expect(expectErr(await recording.stop()).name).toBe('Failed');
	expect(tracks[0]?.stops).toBeGreaterThan(0);
	expect(expectErr(await owner.value.start({ into })).name).toBe(
		'AlreadyRecording',
	);
	blobStore.put = put;
	expectOk(await recording.stop());
	expect(await expectOk(await into.read()).text()).toBe('final');
});

test('meter subscription releases audio graph and animation without stopping capture', async () => {
	const { into, owner, recorders } = await setup();
	let closed = 0;
	let disconnected = 0;
	let cancelled = 0;
	replaceGlobal(
		'AudioContext',
		class {
			state = 'running';
			createMediaStreamSource() {
				return {
					connect() {},
					disconnect() {
						disconnected++;
					},
				};
			}
			createAnalyser() {
				return { fftSize: 256, getFloatTimeDomainData() {} };
			}
			async close() {
				closed++;
			}
		},
	);
	replaceGlobal('requestAnimationFrame', () => 1);
	replaceGlobal('cancelAnimationFrame', () => {
		cancelled++;
	});
	const recording = expectOk(await owner.value.start({ into }));
	const off = recording.onLevel(() => {});
	off();
	expect(closed).toBe(1);
	expect(disconnected).toBe(1);
	expect(cancelled).toBe(1);
	expect(recorders[0]?.state).toBe('recording');
	expectOk(await recording.cancel());
});

test('stop before the start event settles acquisition and releases tracks', async () => {
	const { into, owner, tracks } = await setup({ stopBeforeStart: true });
	expect(expectErr(await owner.value.start({ into })).name).toBe(
		'RecorderFailed',
	);
	expect(tracks[0]?.stops).toBeGreaterThan(0);
	expect(expectOk(await owner.value.current())).toBeNull();
});

test('close waits for permission then discards late capture and stays terminal', async () => {
	const { into, owner, permission, tracks, appId } = await setup({
		deferPermission: true,
	});
	const starting = owner.value.start({ into });
	const closing = owner.close();
	expect(owner.close()).toBe(closing);
	expect(() => owner.value.start({ into })).toThrow('closed');
	expect(() => owner.value.current()).toThrow('closed');
	expect(() => owner.value.enumerateDevices()).toThrow('closed');
	let finished = false;
	void closing.then(() => {
		finished = true;
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	permission.resolve();
	const recording = expectOk(await starting);
	await closing;
	expect(tracks[0]?.stops).toBeGreaterThan(0);
	expect(() => recording.stop()).toThrow('closed');
	expect(() => recording.cancel()).toThrow('closed');
	expect(() => recording.onLevel(() => {})).toThrow('closed');
	expect(() => recording.onEnded(() => {})).toThrow('closed');
	const store = createBrowserBlobStore({
		appId,
		replica: { library: 'local' as const },
	});
	expect(
		expectErr(await store.get(attachmentEngineOf(into).storageId)).name,
	).toBe('BlobNotFound');
});

test('close drains an admitted stop through row attachment completion', async () => {
	const { into, owner, blobStore } = await setup();
	const publication = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const put = blobStore.put;
	blobStore.put = async (id, blob) => {
		entered.resolve();
		await publication.promise;
		return put(id, blob);
	};
	const recording = expectOk(await owner.value.start({ into }));
	const stopping = recording.stop();
	await entered.promise;
	const closing = owner.close();
	let finished = false;
	void closing.then(() => {
		finished = true;
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	publication.resolve();
	expectOk(await stopping);
	await closing;
	expect(await expectOk(await into.read()).text()).toBe('final');
});

test.each([
	false,
	true,
])('close awaits AudioContext release and reports failure=%s', async (fail) => {
	const { into, owner, tracks } = await setup();
	const released = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	replaceGlobal(
		'AudioContext',
		class {
			state = 'running';
			createMediaStreamSource() {
				return { connect() {}, disconnect() {} };
			}
			createAnalyser() {
				return { fftSize: 256 };
			}
			close() {
				entered.resolve();
				return released.promise;
			}
		},
	);
	replaceGlobal('requestAnimationFrame', () => 1);
	replaceGlobal('cancelAnimationFrame', () => {});
	const recording = expectOk(await owner.value.start({ into }));
	recording.onLevel(() => {});
	const closing = owner.close();
	let finished = false;
	void closing.then(
		() => {
			finished = true;
		},
		() => {
			finished = true;
		},
	);
	await entered.promise;
	expect(finished).toBe(false);
	expect(tracks[0]?.stops).toBeGreaterThan(0);
	if (fail) {
		released.reject(new Error('AudioContext release failed'));
		await expect(closing).rejects.toThrow('cleanup failed');
	} else {
		released.resolve();
		await closing;
	}
	expect(owner.close()).toBe(closing);
});

test('close rejects a failed cancellation while still releasing microphone tracks', async () => {
	const { into, owner, recorders, tracks } = await setup();
	expectOk(await owner.value.start({ into }));
	recorders[0]!.stop = () => {
		throw new Error('stop failed');
	};
	await expect(owner.close()).rejects.toThrow('cleanup failed');
	expect(tracks[0]?.stops).toBeGreaterThan(0);
});

test('construction readiness is checked at retained owner and session operations', async () => {
	const { into, appId } = await setup();
	let usable = false;
	const owner = createBrowserRecording(
		appId,
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
	const stop = recording.stop;
	usable = false;
	expect(() => stop()).toThrow('not ready');
	expect(() => recording.onEnded(() => {})).toThrow('not ready');
	await owner.close();
});

test('failed publication retains its Result when AudioContext release also fails', async () => {
	const { into, appId, blobStore } = await setup();
	blobStore.put = async (id) =>
		BlobStoreError.BlobStoreFailed({ id, cause: 'disk full' });
	const owner = createBrowserRecording(appId, { library: 'local' }, {});
	replaceGlobal(
		'AudioContext',
		class {
			state = 'running';
			createMediaStreamSource() {
				return { connect() {}, disconnect() {} };
			}
			createAnalyser() {
				return { fftSize: 256 };
			}
			async close() {
				throw new Error('meter release failed');
			}
		},
	);
	replaceGlobal('requestAnimationFrame', () => 1);
	replaceGlobal('cancelAnimationFrame', () => {});
	const recording = expectOk(await owner.value.start({ into }));
	recording.onLevel(() => {});
	expect(expectErr(await recording.stop()).name).toBe('Failed');
	await expect(owner.close()).rejects.toThrow('cleanup failed');
});
