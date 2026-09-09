/**
 * Browser recording lifecycle tests.
 * Verifies permission races, destination capture, final data publication, and
 * failed capture recovery through browser API fakes and real IndexedDB storage.
 */
import { afterEach, expect, test } from 'bun:test';
import { createBrowserBlobStore } from '@epicenter/blobs/browser';
import { IDBFactory } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { asPrincipalId } from '@epicenter/principal';
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

function setup({
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
				if (deferPermission) await permission.promise;
				const track = new Track();
				tracks.push(track);
				return { getTracks: () => [track], getAudioTracks: () => [track] };
			},
		},
	});
	const appId = `test.${crypto.randomUUID()}`;
	return {
		owner: createBrowserRecording(appId, null),
		appId,
		tracks,
		recorders,
		permission,
		acquisitions: () => acquisitions,
	};
}

test('construction is inert and pending permission excludes competing starts', async () => {
	const { owner, acquisitions, permission, tracks } = setup({
		deferPermission: true,
	});
	expect(acquisitions()).toBe(0);
	const pending = owner.value.start();
	expect(expectErr(await owner.value.start()).name).toBe('AlreadyRecording');
	expect(expectErr(await owner.value.current()).name).toBe('AlreadyRecording');
	expect(acquisitions()).toBe(1);
	permission.resolve();
	const recording = expectOk(await pending);
	expectOk(await recording.cancel());
	expect(tracks[0]?.stops).toBeGreaterThan(0);
});

test('stop stores final data in the captured account even when the input object changes', async () => {
	const { appId, permission, recorders } = setup({ deferPermission: true });
	const account = { authorityId: 'first', principalId: asPrincipalId('alice') };
	const owner = createBrowserRecording(appId, account);
	account.authorityId = 'second';
	const pending = owner.value.start();
	permission.resolve();
	const recording = expectOk(await pending);
	expect(Reflect.set(recording, 'account', null)).toBe(false);
	expect(expectOk(await owner.value.current())).toBe(recording);
	recorders[0]?.data('first');
	const stopped = expectOk(await recording.stop());
	const store = createBrowserBlobStore({
		appId,
		authorityId: 'first',
		principalId: account.principalId,
	});
	expect(await expectOk(await store.get(stopped.audioBlobId)).text()).toBe(
		'firstfinal',
	);
	expect(stopped.byteLength).toBe(10);
	expect(expectOk(await owner.value.current())).toBeNull();
});

test('cancel discards bytes and a stale session cannot stop its successor', async () => {
	const { owner, appId, recorders } = setup();
	const first = expectOk(await owner.value.start());
	expectOk(await first.cancel());
	const second = expectOk(await owner.value.start());
	expect(expectErr(await first.stop()).name).toBe('NoActiveRecording');
	expect(recorders[1]?.state).toBe('recording');
	const store = createBrowserBlobStore({ appId, principalId: 'local' });
	expect(expectErr(await store.get(first.audioBlobId)).name).toBe(
		'BlobNotFound',
	);
	expectOk(await second.cancel());
});

test('an asynchronous start error releases capture and permits another acquisition', async () => {
	const { owner, tracks, acquisitions } = setup({ failStart: true });
	expect(expectErr(await owner.value.start()).name).toBe('RecorderFailed');
	expect(tracks[0]?.stops).toBeGreaterThan(0);
	expect(expectErr(await owner.value.start()).name).toBe('RecorderFailed');
	expect(acquisitions()).toBe(2);
});

test('capture error preserves its final bytes for stop and reports ended once', async () => {
	const { owner, appId, recorders, tracks } = setup();
	const recording = expectOk(await owner.value.start());
	const reasons: string[] = [];
	recording.onEnded((reason) => reasons.push(reason));
	recorders[0]?.data('before');
	recorders[0]?.fail();
	const stopped = expectOk(await recording.stop());
	expect(reasons).toEqual(['streamFailed']);
	expect(tracks[0]?.stops).toBeGreaterThan(0);
	const store = createBrowserBlobStore({ appId, principalId: 'local' });
	expect(await expectOk(await store.get(stopped.audioBlobId)).text()).toBe(
		'beforesaved',
	);
});

test('disconnected device remains resolvable and concurrent stop cannot publish twice', async () => {
	const { owner, tracks } = setup();
	const recording = expectOk(await owner.value.start());
	tracks[0]?.dispatchEvent(new Event('ended'));
	expect(recording.endedReason).toBe('deviceDisconnected');
	const stopped = recording.stop();
	expect(expectErr(await recording.cancel()).name).toBe('NoActiveRecording');
	expectOk(await stopped);
});

test('late ended subscription delivers once and an unsubscribed listener is skipped', async () => {
	const { owner, tracks } = setup();
	const recording = expectOk(await owner.value.start());
	tracks[0]?.dispatchEvent(new Event('ended'));
	const reasons: string[] = [];
	recording.onEnded((reason) => reasons.push(reason));
	const off = recording.onEnded(() => reasons.push('removed'));
	off();
	await Promise.resolve();
	expect(reasons).toEqual(['deviceDisconnected']);
	expectOk(await recording.cancel());
});

test('failed publication releases capture and does not hold the next start', async () => {
	const { owner, tracks } = setup();
	// Missing Web Locks makes the real store refuse publication.
	Object.defineProperty(navigator, 'locks', { value: undefined });
	const recording = expectOk(await owner.value.start());
	expect(expectErr(await recording.stop()).name).toBe('BlobStoreFailed');
	expect(tracks[0]?.stops).toBeGreaterThan(0);
	const next = expectOk(await owner.value.start());
	expectOk(await next.cancel());
});

test('meter subscription releases audio graph and animation without stopping capture', async () => {
	const { owner, recorders } = setup();
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
	const recording = expectOk(await owner.value.start());
	const off = recording.onLevel(() => {});
	off();
	expect(closed).toBe(1);
	expect(disconnected).toBe(1);
	expect(cancelled).toBe(1);
	expect(recorders[0]?.state).toBe('recording');
	expectOk(await recording.cancel());
});

test('stop before the start event settles acquisition and releases tracks', async () => {
	const { owner, tracks } = setup({ stopBeforeStart: true });
	expect(expectErr(await owner.value.start()).name).toBe('RecorderFailed');
	expect(tracks[0]?.stops).toBeGreaterThan(0);
	expect(expectOk(await owner.value.current())).toBeNull();
});

test('close waits for permission then discards late capture and stays terminal', async () => {
	const { owner, permission, tracks, appId } = setup({
		deferPermission: true,
	});
	const starting = owner.value.start();
	const closing = owner.close();
	expect(owner.close()).toBe(closing);
	expect(() => owner.value.start()).toThrow('closed');
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
	const store = createBrowserBlobStore({ appId, principalId: 'local' });
	expect(expectErr(await store.get(recording.audioBlobId)).name).toBe(
		'BlobNotFound',
	);
});

test('close drains an admitted stop through final blob publication', async () => {
	const { owner, appId } = setup();
	const publication = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	Object.defineProperty(navigator, 'locks', {
		value: {
			request: async (
				_name: string,
				_options: unknown,
				callback: (lock: object) => unknown,
			) => {
				entered.resolve();
				await publication.promise;
				return callback({});
			},
		},
	});
	const recording = expectOk(await owner.value.start());
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
	const saved = expectOk(await stopping);
	await closing;
	const store = createBrowserBlobStore({ appId, principalId: 'local' });
	expect(await expectOk(await store.get(saved.audioBlobId)).text()).toBe(
		'final',
	);
});

test.each([
	false,
	true,
])('close awaits AudioContext release and reports failure=%s', async (fail) => {
	const { owner, tracks } = setup();
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
	const recording = expectOk(await owner.value.start());
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
	const { owner, recorders, tracks } = setup();
	expectOk(await owner.value.start());
	recorders[0]!.stop = () => {
		throw new Error('stop failed');
	};
	await expect(owner.close()).rejects.toThrow('cleanup failed');
	expect(tracks[0]?.stops).toBeGreaterThan(0);
});

test('construction readiness is checked at retained owner and session operations', async () => {
	const { appId } = setup();
	let usable = false;
	const owner = createBrowserRecording(appId, null, {
		assertUsable() {
			if (!usable) throw new Error('not ready');
		},
	});
	const start = owner.value.start;
	expect(() => start()).toThrow('not ready');
	usable = true;
	const recording = expectOk(await start());
	const stop = recording.stop;
	usable = false;
	expect(() => stop()).toThrow('not ready');
	expect(() => recording.onEnded(() => {})).toThrow('not ready');
	await owner.close();
});

test('failed publication retains its Result when AudioContext release also fails', async () => {
	const { owner } = setup();
	Object.defineProperty(navigator, 'locks', { value: undefined });
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
	const recording = expectOk(await owner.value.start());
	recording.onLevel(() => {});
	expect(expectErr(await recording.stop()).name).toBe('BlobStoreFailed');
	await expect(owner.close()).rejects.toThrow('cleanup failed');
});
