/**
 * Saved recording belongs to its supplied blob destination.
 * Checks deferred acquisition and publication,
 * native recovery, and release before close resolves.
 */
import { expect, test } from 'bun:test';
import { generateBlobId } from '@epicenter/blobs';
import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import { asDeviceIdentifier } from '@epicenter/recorder';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { acquireLocalBlobs } from './blob-owner.js';
import { defineApp } from './index.js';
import { openLocal } from './open-store.js';
import {
	createRecorder,
	RecorderError,
	type Recording,
	type RecordingFactory,
} from './recorder.js';
import { createMemoryStoreRuntime } from './testing.js';

function setup({
	startGate = Promise.resolve(),
	stopGate = Promise.resolve(),
	cancelGate = Promise.resolve(),
	saveGate = Promise.resolve(),
	recoveryFailsAfterStart = false,
	recoveryFails = false,
	cancelFails = false,
	closeThrows = false,
} = {}) {
	const appId = 'test.' + crypto.randomUUID();
	const bindings: { appId: string }[] = [];
	let starts = 0;
	let cancels = 0;
	let stops = 0;

	let recorderCloses = 0;
	const savingEntered = Promise.withResolvers<void>();
	const recording: RecordingFactory = (appId, options) => {
		bindings.push({ appId });
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
		const audioBlobId = generateBlobId('wav');
		const session: Recording = {
			id: audioBlobId,
			device: { outcome: 'success', deviceId: asDeviceIdentifier('mic') },
			endedReason: null,
			stop: () =>
				run(async () => {
					stops++;
					await stopGate;
					const written = await options.write(audioBlobId, new Blob(['audio']));
					if (written.error)
						return RecorderError.RecorderFailed({ cause: written.error });
					active = null;
					return Ok({
						blobId: audioBlobId,
						durationMs: 100,
						byteLength: 5,
					});
				}),
			cancel: () => run(cancel),
			onLevel: () => () => {},
			onEnded: () => () => {},
		};
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
				if (closeThrows)
					throw new Error('Synchronous recorder cleanup failure');
				recorderCloses++;
				closed = true;
				closing ??= (async () => {
					await Promise.allSettled(pending);
					if (active === null) {
						const result = await current();
						if (result.error) throw result.error;
					}
					if (active !== null) {
						const result = await cancel();
						if (result.error) throw result.error;
					}
				})();
				return closing;
			},
		};
	};
	const idb = { factory: new IDBFactory(), keyRange: IDBKeyRange };
	const runtime = createMemoryStoreRuntime();
	const definition = defineApp({ id: appId, tables: {}, kv: {} });
	const openFixture = async () => {
		const local = createBrowserBlobStore({ appId, idb });
		const put = local.put;
		local.put = async (...args) => {
			savingEntered.resolve();
			await saveGate;
			return put(...args);
		};
		const store = await openLocal(definition, {
			runtime: {
				...runtime,
				localBlobs: (id, assertUsable) =>
					acquireLocalBlobs({
						assertUsable,
						id,
						binding: {
							local,
							sources: createBrowserBlobSources(local),
							recording,
						},
					}),
			},
		});
		const recorder = createRecorder({ localBlobs: store.blobs });
		return {
			blobs: store.blobs,
			recorder,
			signal: store.signal,
			close: store.close,
		};
	};
	return {
		openFixture,
		appId,
		bindings,
		starts: () => starts,
		cancels: () => cancels,
		stops: () => stops,
		recorderCloses: () => recorderCloses,
		savingEntered: savingEntered.promise,
	};
}

test('resolved opening binds recording once and permits microphone acquisition', async () => {
	const { openFixture, bindings, starts, appId } = setup();
	expect(bindings).toEqual([]);
	const app = await openFixture();
	expect(bindings).toEqual([{ appId }]);
	expect(starts()).toBe(0);

	const session = expectOk(await app.recorder.start({}));
	expect(expectOk(await app.recorder.current())).toBe(session);
	expectOk(await session.cancel());
	await app.close();
	expect(() => app.recorder.start({})).toThrow();
});

test('close waits for an admitted start and cancels its late capture', async () => {
	const acquisition = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { openFixture, cancels } = setup({
		startGate: acquisition.promise,
		cancelGate: release.promise,
	});
	const app = await openFixture();

	const pending = app.recorder.start({});
	let closed = false;
	const closing = app.close().then(() => {
		closed = true;
	});
	expect(() => app.recorder.current()).toThrow();
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
	const { openFixture, cancels, stops } = setup({
		stopGate: publication.promise,
	});
	const app = await openFixture();

	const session = expectOk(await app.recorder.start({}));
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

test('Stop publishes through private storage after blob close revokes public access', async () => {
	const gate = Promise.withResolvers<void>();
	const context = setup({ saveGate: gate.promise });
	const app = await context.openFixture();

	const recording = expectOk(await app.recorder.start({}));
	const saving = recording.stop();
	await context.savingEntered;
	const closing = app.close();
	expect(() => app.blobs.list()).toThrow();
	gate.resolve();
	const saved = expectOk(await saving);
	await closing;
	const reopened = await context.openFixture();

	expect(await expectOk(await reopened.blobs.get(saved.blobId)).text()).toBe(
		'audio',
	);
	expect(
		expectOk(await reopened.blobs.list()).items.map((item) => item.id),
	).toContain(saved.blobId);
	await reopened.close();
});

test('close releases a session owned by its recorder even without a prior current call', async () => {
	const { openFixture, cancels } = setup();
	const app = await openFixture();

	expectOk(await app.recorder.start({}));
	await app.close();
	expect(cancels()).toBe(1);
});

test('close cancels a held capture without depending on a recovery read', async () => {
	const { openFixture, cancels } = setup({ recoveryFailsAfterStart: true });
	const app = await openFixture();

	expectOk(await app.recorder.start({}));
	await app.close();
	expect(cancels()).toBe(1);
});

test('synchronous recorder cleanup failure rejects the terminal promise and store shutdown', async () => {
	const context = setup({ closeThrows: true });
	const store = await context.openFixture();
	const closing = store.recorder.close();
	expect(store.recorder.close()).toBe(closing);
	await expect(closing).rejects.toThrow('Synchronous recorder cleanup failure');
	await expect(store.close()).rejects.toThrow('Local blob cleanup failed');
	await expect(context.openFixture()).rejects.toMatchObject({
		name: 'AlreadyOpen',
	});
});
