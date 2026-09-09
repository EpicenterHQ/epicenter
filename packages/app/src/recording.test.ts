/**
 * Saved recording belongs to the opened app, including readiness and closure.
 * Checks fixed local/account destinations, deferred acquisition/publication,
 * native recovery, and release before close resolves.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { generateBlobId } from '@epicenter/blobs';
import { defineData } from '@epicenter/data/definition';
import { installTestLocks } from '@epicenter/data/test-locks';
import { asPrincipalId } from '@epicenter/principal';
import { asDeviceIdentifier } from '@epicenter/recorder';
import {
	RecorderError,
	type Recording,
	type RecordingAccount,
	type RecordingFactory,
} from '@epicenter/recorder/recording';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { createEpicenter } from './index.js';
import { createBrowserAppBlobs } from './browser.js';

installTestLocks();

function setup({
	startGate = Promise.resolve(),
	stopGate = Promise.resolve(),
	cancelGate = Promise.resolve(),
	recovered = false,
	recoveryFailsAfterStart = false,
} = {}) {
	const appId = 'test.' + crypto.randomUUID();
	const bindings: { appId: string; account: RecordingAccount }[] = [];
	let starts = 0;
	let cancels = 0;
	let stops = 0;
	const recording: RecordingFactory = (appId, account) => {
		bindings.push({ appId, account });
		let active: Recording | null = null;
		const audioBlobId = generateBlobId();
		const session: Recording = {
			audioBlobId,
			account,
			device: { outcome: 'success', deviceId: asDeviceIdentifier('mic') },
			endedReason: null,
			async stop() {
				stops++;
				await stopGate;
				active = null;
				return Ok({ audioBlobId, durationMs: 100, byteLength: 32 });
			},
			async cancel() {
				cancels++;
				await cancelGate;
				active = null;
				return Ok(undefined);
			},
			onLevel: () => () => {},
			onEnded: () => () => {},
		};
		if (recovered) active = session;
		return {
			current: async () =>
				recoveryFailsAfterStart && starts > 0
					? RecorderError.RecorderFailed({
							cause: new Error('Recovery unavailable'),
						})
					: Ok(active),
			enumerateDevices: async () => Ok([]),
			async start() {
				starts++;
				if (active) return RecorderError.AlreadyRecording();
				await startGate;
				active = session;
				return Ok(session);
			},
		};
	};
	const epicenter = createEpicenter({
		appId,
		definition: defineData({ id: appId, kv: {}, tables: {} }),
		sqlite: {
			open: async () => {
				throw new Error('Unused');
			},
			delete: async () => {},
		},
		blobs: createBrowserAppBlobs(),
		recording,
	});
	return {
		epicenter,
		appId,
		bindings,
		starts: () => starts,
		cancels: () => cancels,
		stops: () => stops,
	};
}

test('opening binds recording once and readiness gates microphone acquisition', async () => {
	const { epicenter, bindings, starts, appId } = setup();
	expect(bindings).toEqual([]);
	expect(Object.hasOwn(epicenter, 'recording')).toBe(false);
	const app = epicenter.openLocal();
	expect(bindings).toEqual([{ appId, account: null }]);
	expect(() => app.recording.start()).toThrow('not ready');
	expect(starts()).toBe(0);
	expectOk(await app.ready);
	const session = expectOk(await app.recording.start());
	expect(expectOk(await app.recording.current())).toBe(session);
	expect(session.account).toBeNull();
	expectOk(await session.cancel());
	await app.close();
	expect(() => app.recording.start()).toThrow();
});

test('account recording keeps the opened identity when the supplied account changes', async () => {
	const { epicenter, bindings } = setup();
	const account: Account = {
		authorityId: 'original',
		principalId: asPrincipalId('alice'),
		baseURL: 'https://example.test',
		fetch: async () =>
			Response.json({ generations: [], generation: 1, position: 0 }),
		openWebSocket: async () => {
			throw new Error('Unused');
		},
		getProfile: async () => {
			throw new Error('Unused');
		},
	};
	const app = epicenter.openAccount(account);
	Reflect.set(account, 'authorityId', 'replacement');
	expectOk(await app.ready);
	const session = expectOk(await app.recording.start());
	expect(session.account?.authorityId).toBe('original');
	expect(bindings[0]?.account?.authorityId).toBe('original');
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
