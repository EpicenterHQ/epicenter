/**
 * Saved recording belongs to the opened app, including readiness and closure.
 * Checks fixed local/account destinations, deferred acquisition/publication,
 * native recovery, and release before close resolves.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import {
	RecorderError,
	type Recording,
	type RecordingFactory,
	type RecordingReplica,
} from '@epicenter/app/recorder';
import type { Account } from '@epicenter/auth';
import { generateBlobId } from '@epicenter/blobs';
import { defineData } from '@epicenter/data/definition';
import { installTestLocks } from '@epicenter/device/test-locks';
import { asPrincipalId } from '@epicenter/principal';
import { asDeviceIdentifier } from '@epicenter/recorder';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { browser, createBrowserAppBlobs } from './browser.js';
import { defineApplication } from './index.js';

installTestLocks();

function setup({
	startGate = Promise.resolve(),
	stopGate = Promise.resolve(),
	cancelGate = Promise.resolve(),
	recovered = false,
	recoveryFailsAfterStart = false,
	recoveryFails = false,
	cancelFails = false,
} = {}) {
	const appId = 'test.' + crypto.randomUUID();
	const bindings: { appId: string; replica: RecordingReplica }[] = [];
	let starts = 0;
	let cancels = 0;
	let stops = 0;
	let releases = 0;
	const recording: RecordingFactory = (appId, replica, options) => {
		bindings.push({ appId, replica });
		let active: Recording | null = null;
		let closed = false;
		let closing: Promise<void> | undefined;
		const pending = new Set<Promise<unknown>>();
		function run<T>(operation: () => Promise<T>): Promise<T> {
			options.assertUsable?.();
			if (closed) throw new Error('Recorder is closed.');
			const promise = Promise.resolve().then(operation);
			pending.add(promise);
			void promise.then(
				() => pending.delete(promise),
				() => pending.delete(promise),
			);
			return promise;
		}
		async function cancel() {
			cancels++;
			await cancelGate;
			if (cancelFails)
				return RecorderError.RecorderFailed({
					cause: new Error('Cancellation failed'),
				});
			active = null;
			return Ok(undefined);
		}
		async function current() {
			return recoveryFails || (recoveryFailsAfterStart && starts > 0)
				? RecorderError.RecorderFailed({
						cause: new Error('Recovery unavailable'),
					})
				: Ok(active);
		}
		const audioBlobId = generateBlobId();
		const session: Recording = {
			audioBlobId,
			replica,
			device: { outcome: 'success', deviceId: asDeviceIdentifier('mic') },
			endedReason: null,
			stop: () =>
				run(async () => {
					stops++;
					await stopGate;
					active = null;
					return Ok({ audioBlobId, durationMs: 100, byteLength: 32 });
				}),
			cancel: () => run(cancel),
			onLevel: () => () => {},
			onEnded: () => () => {},
		};
		if (recovered) active = session;
		return {
			value: {
				current: () => run(current),
				enumerateDevices: () => run(async () => Ok([])),
				start: () =>
					run(async () => {
						starts++;
						if (active) return RecorderError.AlreadyRecording();
						await startGate;
						active = session;
						return Ok(session);
					}),
			},
			close() {
				closed = true;
				return (closing ??= (async () => {
					await Promise.allSettled(pending);
					if (active === null && (options.canRecover?.() ?? true)) {
						const result = await current();
						if (result.error) throw result.error;
					}
					if (active !== null && (options.canRecover?.() ?? true)) {
						const result = await cancel();
						if (result.error) throw result.error;
					}
				})());
			},
		};
	};
	const epicenter = defineApplication({
		appId,
		definition: defineData({ id: appId, kv: {}, tables: {} }),
		runtime: {
			...browser,
			sqlite: {
				acquire: async () => ({
					open: async () => {
						throw new Error('Unused');
					},
					delete: async () => {},

					close: async () => {
						releases++;
					},
				}),
			},
			blobs: createBrowserAppBlobs(),
			recording,
		},
		ai: { runtime: null, account: null },
	});
	return {
		epicenter,
		appId,
		bindings,
		starts: () => starts,
		cancels: () => cancels,
		stops: () => stops,
		releases: () => releases,
	};
}

test('opening binds recording once and readiness gates microphone acquisition', async () => {
	const { epicenter, bindings, starts, appId } = setup();
	expect(bindings).toEqual([]);
	expect(Object.hasOwn(epicenter, 'recording')).toBe(false);
	const app = epicenter.openLocal();
	expect(bindings).toEqual([{ appId, replica: { library: 'local' } }]);
	expect(() => app.recording.start()).toThrow('not ready');
	expect(starts()).toBe(0);
	expectOk(await app.ready);
	const session = expectOk(await app.recording.start());
	expect(expectOk(await app.recording.current())).toBe(session);
	expect(session.replica).toEqual({ library: 'local' });
	expectOk(await session.cancel());
	await app.close();
	expect(() => app.recording.start()).toThrow();
});

test('account recording keeps the opened identity when the supplied account changes', async () => {
	const { epicenter, bindings } = setup();
	let state: Blob | null = null;
	const account: Account = {
		authorityId: 'original',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://example.test',
		async fetch(_input, init) {
			state ??= await new Response(init?.body).blob();
			return createCurrentDownloadResponse({
				generation: 1,
				head: 1,
				snapshot: {
					position: 1,
					bytes: new Uint8Array(await state.arrayBuffer()),
				},
				tail: [],
			});
		},
		openWebSocket: async () => {
			throw new Error('Unused');
		},
		getProfile: async () => {
			throw new Error('Unused');
		},
	};
	const app = epicenter.openPersonal(account);
	Reflect.set(account, 'authorityId', 'replacement');
	expectOk(await app.ready);
	const session = expectOk(await app.recording.start());
	expect(session.replica).toEqual({
		library: 'personal',
		account: { authorityId: 'original', principalId: asPrincipalId('alice') },
	});
	expect(bindings[0]?.replica).toEqual(session.replica);
	await app.close();
});

test('close waits for an admitted start and cancels its late capture', async () => {
	const acquisition = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { epicenter, cancels } = setup({
		startGate: acquisition.promise,
		cancelGate: release.promise,
	});
	const app = epicenter.openLocal();
	expectOk(await app.ready);
	const pending = app.recording.start();
	let closed = false;
	const closing = app.close().then(() => {
		closed = true;
	});
	expect(() => app.recording.current()).toThrow();
	acquisition.resolve();
	const session = expectOk(await pending);
	await Promise.resolve();
	expect(closed).toBe(false);
	release.resolve();
	await closing;
	expect(cancels()).toBe(1);
	expect(() => session.stop()).toThrow();
});

test('close drains admitted publication without cancelling it', async () => {
	const publication = Promise.withResolvers<void>();
	const { epicenter, cancels, stops } = setup({
		stopGate: publication.promise,
	});
	const app = epicenter.openLocal();
	expectOk(await app.ready);
	const session = expectOk(await app.recording.start());
	const pending = session.stop();
	let closed = false;
	const closing = app.close().then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	publication.resolve();
	expectOk(await pending);
	await closing;
	expect(stops()).toBe(1);
	expect(cancels()).toBe(0);
});

test('close recovers and releases a native capture even without a prior current call', async () => {
	const { epicenter, cancels } = setup({ recovered: true });
	const app = epicenter.openLocal();
	expectOk(await app.ready);
	await app.close();
	expect(cancels()).toBe(1);
});

test('a refused duplicate open cannot cancel the owning app capture', async () => {
	const { epicenter, cancels } = setup({ recovered: true });
	const owner = epicenter.openLocal();
	expectOk(await owner.ready);
	const duplicate = epicenter.openLocal();
	expect(expectErr(await duplicate.ready).name).toBe('AlreadyOpen');
	await duplicate.close();
	expect(cancels()).toBe(0);
	await owner.close();
	expect(cancels()).toBe(1);
});

test('closing a duplicate before acquisition cannot cancel the owning app capture', async () => {
	const { epicenter, cancels } = setup({ recovered: true });
	const owner = epicenter.openLocal();
	expectOk(await owner.ready);
	const duplicate = epicenter.openLocal();
	await duplicate.close();
	expectErr(await duplicate.ready);
	expect(cancels()).toBe(0);
	await owner.close();
	expect(cancels()).toBe(1);
});

test('close cancels a held capture without depending on a recovery read', async () => {
	const { epicenter, cancels } = setup({ recoveryFailsAfterStart: true });
	const app = epicenter.openLocal();
	expectOk(await app.ready);
	expectOk(await app.recording.start());
	await app.close();
	expect(cancels()).toBe(1);
});

test('closing before readiness never admits a new recording', async () => {
	const { epicenter, starts } = setup();
	const app = epicenter.openLocal();
	await app.close();
	expect(starts()).toBe(0);
	expect(() => app.recording.start()).toThrow();
});

for (const failure of ['recovery', 'cancellation'] as const) {
	test(`failed ${failure} retains ownership while other libraries remain usable`, async () => {
		const { epicenter, releases } = setup({
			recoveryFails: failure === 'recovery',
			cancelFails: failure === 'cancellation',
		});
		const app = epicenter.openLocal();
		expectOk(await app.ready);
		if (failure === 'cancellation') expectOk(await app.recording.start());
		await expect(app.close()).rejects.toMatchObject({ name: 'RecorderFailed' });
		expect(releases()).toBe(0);
		const duplicate = epicenter.openLocal();
		expect(expectErr(await duplicate.ready).name).toBe('AlreadyOpen');
		await duplicate.close();
		const other = setup().epicenter.openLocal();
		expectOk(await other.ready);
		await other.close();
	});
}
