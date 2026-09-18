/**
 * Saved recording belongs to the opened app, including readiness and closure.
 * Checks fixed local/account destinations, deferred acquisition/publication,
 * native recovery, and release before close resolves.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { defineTable, field, plainText } from '@epicenter/app';
import {
	RecorderError,
	type Recording,
	type RecordingFactory,
} from '@epicenter/app/recorder';
import type { Account } from '@epicenter/auth';
import { generateBlobId } from '@epicenter/blobs';
import { installTestLocks } from '@epicenter/device/test-locks';
import { asPrincipalId } from '@epicenter/principal';
import { asDeviceIdentifier } from '@epicenter/recorder';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { composeApp } from './compose.js';
import { defineApp } from './index.js';
import {
	resources as browser,
	createBrowserAppBlobs,
} from './platform/browser.js';

installTestLocks();

function setup({
	startGate = Promise.resolve(),
	stopGate = Promise.resolve(),
	cancelGate = Promise.resolve(),
	saveGate = Promise.resolve(),
	recoveryFailsAfterStart = false,
	recoveryFails = false,
	cancelFails = false,
} = {}) {
	const appId = 'test.' + crypto.randomUUID();
	const bindings: { appId: string }[] = [];
	let starts = 0;
	let cancels = 0;
	let stops = 0;
	let releases = 0;
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
	const fixtureDefinition = defineApp({
		kv: {},
		tables: {
			recordings: defineTable({
				audio: field.string(),
				content: plainText(),
			}),
		},
		id: appId,
	});
	const openFixture = (account?: Account) =>
		composeApp(fixtureDefinition, {
			appId: fixtureDefinition.id,
			account,
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
			blobs(input) {
				const blobs = createBrowserAppBlobs()(input);
				const put = blobs.local.put;
				blobs.local.put = async (...args) => {
					savingEntered.resolve();
					await saveGate;
					return put(...args);
				};
				return blobs;
			},
			recording,
			ai: { runtime: null, account: null },
		});
	return {
		openFixture,
		appId,
		bindings,
		starts: () => starts,
		cancels: () => cancels,
		stops: () => stops,
		releases: () => releases,
		recorderCloses: () => recorderCloses,
		savingEntered: savingEntered.promise,
	};
}

test('opening binds recording once and readiness gates microphone acquisition', async () => {
	const { openFixture, bindings, starts, appId } = setup();
	expect(bindings).toEqual([]);
	const app = openFixture();
	expect(bindings).toEqual([{ appId }]);
	expect(() => app.device.recording.start({})).toThrow('not ready');
	expect(starts()).toBe(0);
	expectOk(await app.ready);
	const session = expectOk(await app.device.recording.start({}));
	expect(expectOk(await app.device.recording.current())).toBe(session);
	expectOk(await session.cancel());
	await app.close();
	expect(() => app.device.recording.start({})).toThrow();
});

test('account recording keeps the opened identity when the supplied account changes', async () => {
	const { openFixture, bindings } = setup();
	let state: Blob | null = null;
	const account: Account = {
		supportsShared: false,
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
	const app = openFixture(account);
	Reflect.set(account, 'authorityId', 'replacement');
	expectOk(await app.ready);
	const session = expectOk(await app.device.recording.start({}));
	expect(expectOk(await app.device.recording.current())).toBe(session);
	expect(bindings[0]?.appId).toBe(app.appId);
	await app.close();
});

test('close waits for an admitted start and cancels its late capture', async () => {
	const acquisition = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { openFixture, cancels } = setup({
		startGate: acquisition.promise,
		cancelGate: release.promise,
	});
	const app = openFixture();
	expectOk(await app.ready);
	const pending = app.device.recording.start({});
	let closed = false;
	const closing = app.close().then(() => {
		closed = true;
	});
	expect(() => app.device.recording.current()).toThrow();
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
	const app = openFixture();
	expectOk(await app.ready);
	const session = expectOk(await app.device.recording.start({}));
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

test('Stop publishes through private storage after App close revokes public access', async () => {
	const gate = Promise.withResolvers<void>();
	const context = setup({ saveGate: gate.promise });
	const app = context.openFixture();
	expectOk(await app.ready);
	const recording = expectOk(await app.device.recording.start({}));
	const saving = recording.stop();
	await context.savingEntered;
	const closing = app.close();
	expect(() => app.blobs.local.list()).toThrow();
	gate.resolve();
	const saved = expectOk(await saving);
	await closing;
	const reopened = context.openFixture();
	expectOk(await reopened.ready);
	expect(
		await expectOk(await reopened.blobs.local.get(saved.blobId)).text(),
	).toBe('audio');
	expect(reopened.device.tables.recordings.rows).toHaveLength(0);
	expect(
		expectOk(await reopened.blobs.local.list()).items.map((item) => item.id),
	).toContain(saved.blobId);
	await reopened.close();
});

test('close releases a session owned by its recorder even without a prior current call', async () => {
	const { openFixture, cancels } = setup();
	const app = openFixture();
	expectOk(await app.ready);
	expectOk(await app.device.recording.start({}));
	await app.close();
	expect(cancels()).toBe(1);
});

test('a refused duplicate open cannot cancel the owning app capture', async () => {
	const { openFixture, cancels } = setup();
	const owner = openFixture();
	expectOk(await owner.ready);
	expectOk(await owner.device.recording.start({}));
	const duplicate = openFixture();
	expect(expectErr(await duplicate.ready).name).toBe('AlreadyOpen');
	await duplicate.close();
	expect(cancels()).toBe(0);
	await owner.close();
	expect(cancels()).toBe(1);
});

test('closing a duplicate before acquisition cannot cancel the owning app capture', async () => {
	const { openFixture, cancels } = setup();
	const owner = openFixture();
	expectOk(await owner.ready);
	expectOk(await owner.device.recording.start({}));
	const duplicate = openFixture();
	await duplicate.close();
	expectErr(await duplicate.ready);
	expect(cancels()).toBe(0);
	await owner.close();
	expect(cancels()).toBe(1);
});

test('close cancels a held capture without depending on a recovery read', async () => {
	const { openFixture, cancels } = setup({ recoveryFailsAfterStart: true });
	const app = openFixture();
	expectOk(await app.ready);
	expectOk(await app.device.recording.start({}));
	await app.close();
	expect(cancels()).toBe(1);
});

test('closing before readiness never admits a new recording', async () => {
	const { openFixture, starts } = setup();
	const app = openFixture();
	await app.close();
	expect(starts()).toBe(0);
	expect(() => app.device.recording.start({})).toThrow();
});

for (const failure of ['cancellation'] as const) {
	test(`failed ${failure} retains ownership while other libraries remain usable`, async () => {
		const { openFixture, releases } = setup({
			cancelFails: failure === 'cancellation',
		});
		const app = openFixture();
		expectOk(await app.ready);
		if (failure === 'cancellation')
			expectOk(await app.device.recording.start({}));
		await expect(app.close()).rejects.toMatchObject({ name: 'RecorderFailed' });
		expect(releases()).toBe(0);
		const duplicate = openFixture();
		expect(expectErr(await duplicate.ready).name).toBe('AlreadyOpen');
		await duplicate.close();
		const other = setup().openFixture();
		expectOk(await other.ready);
		await other.close();
	});
}
