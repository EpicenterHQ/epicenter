/**
 * Browser recording lifecycle tests.
 * Verifies permission races, destination capture, final data publication, and
 * failed capture recovery through browser API fakes and real IndexedDB storage.
 */
import { afterEach, expect, test } from 'bun:test';
import { BlobStoreError } from '@epicenter/blobs';
import { createBrowserBlobStore } from '@epicenter/blobs/browser';
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

test('capture creates no row; saving the finished file creates the destination owner', async () => {
	const { owner, table } = await setup();
	const session = expectOk(await owner.value.start({}));
	expect(table.ids()).toEqual([]);
	const finished = expectOk(await session.stop());
	expect(table.ids()).toEqual([]);
	const row = expectOk(await table.create({ audio: finished.file }));
	expect(await expectOk(await table.attachment(row.id).read()).text()).toBe(
		'final',
	);
	await owner.close();
});

test('capture retains its original account identity while the supplied account changes', async () => {
	const { appId } = await setup();
	const account = {
		authorityId: 'original',
		principalId: asPrincipalId('alice'),
	};
	const owner = createBrowserRecording(
		appId,
		{ library: 'personal', account },
		{},
	);
	account.authorityId = 'replacement';
	const recording = expectOk(await owner.value.start({}));
	expect(recording.replica).toEqual({
		library: 'personal',
		account: { authorityId: 'original', principalId: asPrincipalId('alice') },
	});
	expectOk(await recording.cancel());
	await owner.close();
});

test('construction is inert and pending permission excludes competing starts', async () => {
	const { owner, acquisitions, permission, permissionEntered, tracks } =
		await setup({
			deferPermission: true,
		});
	expect(acquisitions()).toBe(0);
	const pending = owner.value.start({});
	expect(expectErr(await owner.value.start({})).name).toBe('AlreadyRecording');
	expect(expectErr(await owner.value.current()).name).toBe('AlreadyRecording');
	await permissionEntered.promise;
	expect(acquisitions()).toBe(1);
	permission.resolve();
	const recording = expectOk(await pending);
	expectOk(await recording.cancel());
	expect(tracks[0]?.stops).toBeGreaterThan(0);
});

test('finished output saves to the table captured before recording starts', async () => {
	const { owner, table, recorders } = await setup();
	const into = table;
	const session = expectOk(await owner.value.start({}));
	recorders[0]?.data('first');
	const finished = expectOk(await session.stop());
	const row = expectOk(await into.create({ audio: finished.file }));
	expect(await expectOk(await into.attachment(row.id).read()).text()).toBe(
		'firstfinal',
	);
	expect(expectOk(await owner.value.current())).toBeNull();
});

test('failed library publication keeps the finished output usable without holding the microphone', async () => {
	const { owner, table, blobStore, tracks } = await setup();
	const recording = expectOk(await owner.value.start({}));
	const finished = expectOk(await recording.stop());
	const put = blobStore.attachments!.put;
	blobStore.attachments!.put = async (id) =>
		BlobStoreError.BlobStoreFailed({ id, cause: 'disk full' });
	expect(expectErr(await table.create({ audio: finished.file })).name).toBe(
		'Failed',
	);
	expect(table.ids()).toEqual([]);
	expect(tracks[0]?.stops).toBeGreaterThan(0);
	expect(expectOk(await owner.value.current())).toBeNull();
	blobStore.attachments!.put = put;
	const row = expectOk(await table.create({ audio: finished.file }));
	expect(await expectOk(await table.attachment(row.id).read()).text()).toBe(
		'final',
	);
});

test('cancel creates no rows and a stale session cannot stop its successor', async () => {
	const { owner, table, recorders } = await setup();
	const first = expectOk(await owner.value.start({}));
	expectOk(await first.cancel());
	const second = expectOk(await owner.value.start({}));
	expect(expectErr(await first.stop()).name).toBe('NoActiveRecording');
	expect(recorders[1]?.state).toBe('recording');
	expect(table.ids()).toEqual([]);
	expectOk(await second.cancel());
});

test('an asynchronous start error releases capture and permits another acquisition', async () => {
	const { owner, tracks, acquisitions } = await setup({
		failStart: true,
	});
	expect(expectErr(await owner.value.start({})).name).toBe('RecorderFailed');
	expect(tracks[0]?.stops).toBeGreaterThan(0);
	expect(expectErr(await owner.value.start({})).name).toBe('RecorderFailed');
	expect(acquisitions()).toBe(2);
});

test('capture error preserves final temporary bytes for stop and reports ended once', async () => {
	const { owner, recorders, tracks } = await setup();
	const recording = expectOk(await owner.value.start({}));
	const reasons: string[] = [];
	recording.onEnded((reason) => reasons.push(reason));
	recorders[0]?.data('before');
	recorders[0]?.fail();
	const result = expectOk(await recording.stop());
	expect(reasons).toEqual(['streamFailed']);
	expect(tracks[0]?.stops).toBeGreaterThan(0);
	expect(result.file).toBeInstanceOf(Blob);
	expect(await (result.file as Blob).text()).toBe('beforesaved');
});

test('disconnected device remains resolvable and concurrent stop cannot publish twice', async () => {
	const { owner, tracks } = await setup();
	const recording = expectOk(await owner.value.start({}));
	tracks[0]?.dispatchEvent(new Event('ended'));
	expect(recording.endedReason).toBe('deviceDisconnected');
	const stopped = recording.stop();
	expect(expectErr(await recording.cancel()).name).toBe('NoActiveRecording');
	expectOk(await stopped);
});

test('late ended subscription delivers once and an unsubscribed listener is skipped', async () => {
	const { owner, tracks } = await setup();
	const recording = expectOk(await owner.value.start({}));
	tracks[0]?.dispatchEvent(new Event('ended'));
	const reasons: string[] = [];
	recording.onEnded((reason) => reasons.push(reason));
	const off = recording.onEnded(() => reasons.push('removed'));
	off();
	await Promise.resolve();
	expect(reasons).toEqual(['deviceDisconnected']);
	expectOk(await recording.cancel());
});

test('stopping frees capture while the caller owns finished bytes', async () => {
	const { owner } = await setup();
	const first = expectOk(await owner.value.start({}));
	const finished = expectOk(await first.stop());
	const second = expectOk(await owner.value.start({}));
	expect(await (finished.file as Blob).text()).toBe('final');
	expectOk(await owner.value.discard(finished.file));
	expectOk(await second.cancel());
});

test('meter subscription releases audio graph and animation without stopping capture', async () => {
	const { owner, recorders } = await setup();
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
	const recording = expectOk(await owner.value.start({}));
	const off = recording.onLevel(() => {});
	off();
	expect(closed).toBe(1);
	expect(disconnected).toBe(1);
	expect(cancelled).toBe(1);
	expect(recorders[0]?.state).toBe('recording');
	expectOk(await recording.cancel());
});

test('stop before the start event settles acquisition and releases tracks', async () => {
	const { owner, tracks } = await setup({ stopBeforeStart: true });
	expect(expectErr(await owner.value.start({})).name).toBe('RecorderFailed');
	expect(tracks[0]?.stops).toBeGreaterThan(0);
	expect(expectOk(await owner.value.current())).toBeNull();
});

test('close waits for permission then discards late capture and stays terminal', async () => {
	const { owner, permission, permissionEntered, tracks } = await setup({
		deferPermission: true,
	});
	const starting = owner.value.start({});
	await permissionEntered.promise;
	const closing = owner.close();
	expect(owner.close()).toBe(closing);
	expect(() => owner.value.start({})).toThrow('closed');
	expect(() => owner.value.current()).toThrow('closed');
	expect(() => owner.value.enumerateDevices()).toThrow('closed');
	let finished = false;
	void closing.then(() => {
		finished = true;
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	permission.resolve();
	expect(expectErr(await starting).name).toBe('NoActiveRecording');
	await closing;
	expect(tracks[0]?.stops).toBeGreaterThan(0);
});

test('close drains admitted stop and returns finished temporary bytes', async () => {
	const { owner, table } = await setup();
	const recording = expectOk(await owner.value.start({}));
	const stopping = recording.stop();
	const closing = owner.close();
	const finished = expectOk(await stopping);
	await closing;
	expect(await (finished.file as Blob).text()).toBe('final');
	expect(table.ids()).toEqual([]);
	expect(() => recording.stop()).toThrow('closed');
});

test.each([
	false,
	true,
])('close awaits AudioContext release and reports failure=%s', async (fail) => {
	const { owner, tracks } = await setup();
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
	const recording = expectOk(await owner.value.start({}));
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
	const { owner, recorders, tracks } = await setup();
	expectOk(await owner.value.start({}));
	recorders[0]!.stop = () => {
		throw new Error('stop failed');
	};
	await expect(owner.close()).rejects.toThrow('cleanup failed');
	expect(tracks[0]?.stops).toBeGreaterThan(0);
});

test('construction readiness is checked at retained owner and session operations', async () => {
	const { appId } = await setup();
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
	expect(() => start({})).toThrow('not ready');
	usable = true;
	const recording = expectOk(await start({}));
	const stop = recording.stop;
	usable = false;
	expect(() => stop()).toThrow('not ready');
	expect(() => recording.onEnded(() => {})).toThrow('not ready');
	await owner.close();
});

test('meter release failure preserves finished audio and rejects recorder close', async () => {
	const { owner } = await setup();
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
	const recording = expectOk(await owner.value.start({}));
	recording.onLevel(() => {});
	const finished = expectOk(await recording.stop());
	expect(await (finished.file as Blob).text()).toBe('final');
	await expect(owner.close()).rejects.toThrow('cleanup failed');
});
