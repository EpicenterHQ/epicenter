/**
 * Whispering's domains over an account app handle.
 *
 * Exercises settings defaults, notifications, persistence across reopening,
 * and domain disposal using the real IndexedDB opener.
 */
import 'fake-indexeddb/auto';
import { installTestLocks } from '@epicenter/device/test-locks';

installTestLocks();

import { expect, test } from 'bun:test';

// The recipes domain IS reactive state, so the runes are shimmed to their
// non-reactive meaning (the pattern the other runtime tests use). These
// assertions read imperatively: the question is what the boot acquired, not
// whether a view recomputed.
(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
	<TValue>(value: TValue) => value,
	{ by: <TValue>(derive: () => TValue) => derive() },
);

import { defineApp } from '@epicenter/app';
import { browser, createBrowserAppBlobs } from '@epicenter/app/browser';
import type { Account } from '@epicenter/auth';
import { APPS } from '@epicenter/constants/apps';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../data';

const testSqlite: DeviceSqliteOwner = {
	acquire: async () => ({
		open: async () => ({
			run: async () => Ok({ changes: 0 }),
			all: async () => Ok([]),
			query: async () => Ok({ columns: [], rows: [], truncated: false }),
			batch: async () => Ok({ changes: [] }),
		}),
		delete: async () => undefined,

		close: async () => undefined,
	}),
};
const testBlobs = createBrowserAppBlobs();

import { createWhisperingDomains } from './app';

/**
 * Start each test from empty storage. IndexedDB outlives a test in this
 * process the way it outlives a page in a browser, and these tests each tell a
 * whole multi-generation story from a fresh install.
 */
async function resetStorage(): Promise<void> {
	for (const database of await indexedDB.databases()) {
		const name = database.name;
		if (!name?.startsWith(`epicenter/${APPS.WHISPERING.id}/`)) continue;
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
}

/**
 * A socket that opens and closes through the real driver's event surface.
 */
function createFakeSocket() {
	const listeners = new Map<string, Set<(event: unknown) => void>>();
	const socket = {
		binaryType: 'blob' as BinaryType,
		addEventListener(type: string, listener: (event: unknown) => void) {
			const set = listeners.get(type) ?? new Set();
			set.add(listener);
			listeners.set(type, set);
		},
		send: () => undefined,
		close: () => dispatch('close', {}),
	};
	function dispatch(type: string, event: unknown): void {
		for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
	}
	return {
		socket: socket as unknown as WebSocket,
		open: () => dispatch('open', {}),
	};
}

/**
 * The captured account used by these app tests: generation HTTP and sync.
 * Profile reads throw so an unexpected request fails visibly.
 */
function createFakeAccount({
	principalId = 'principal-under-test',
	openWebSocket = () => {
		throw new Error('this generation must not dial');
	},
}: {
	principalId?: string;
	openWebSocket?: () => Promise<WebSocket>;
}): Account {
	const unused = () => {
		throw new Error('not part of the app boot');
	};
	let state: Uint8Array | undefined;
	const current = async (
		input: Request | string | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const request = new Request(input, init);
		if (
			request.method !== 'POST' ||
			!new URL(request.url).pathname.endsWith('/current')
		)
			throw new Error(
				`Unexpected library request: ${request.method} ${request.url}`,
			);
		state ??= new Uint8Array(await request.arrayBuffer());
		return createCurrentDownloadResponse({
			generation: 1,
			head: 1,
			snapshot: { position: 1, bytes: state },
			tail: [],
		});
	};
	return {
		supportsShared: false,
		authorityId: 'test-authority',
		principalId: asPrincipalId(principalId),
		baseURL: 'https://api.test',
		fetch: current,
		getProfile: unused,
		openWebSocket,
	};
}

/**
 * An account whose every dial simply connects.
 *
 * There is nothing for a dial to announce any more: a replica used to be
 * unavailable until the authority named the document it belonged to, and the
 * generation is in the address now (ADR-0292).
 */
function announcingAccount(principalId: string): Account {
	return createFakeAccount({
		principalId,
		openWebSocket: async () => {
			const fake = createFakeSocket();
			setTimeout(() => fake.open(), 0);
			return fake.socket;
		},
	});
}

/**
 * The two halves `$lib/epicenter.svelte.ts` and the `(app)` layout compose
 * between them, in one call because a test has no layout.
 *
 * The handle comes back beside the app, because `close` is on the handle and
 * nothing else can end what the open acquired (ADR-0340).
 */
async function openWhispering(account: Account) {
	const handle = defineApp({
		...whisperingDefinition,
		runtime: {
			...browser,
			sqlite: testSqlite,
			blobs: testBlobs,
		},
		ai: { runtime: null, account: null },
	});
	const app = handle.open(account);
	expectOk(await app.ready);
	return app;
}

test('constructing a factory acquires no local database', async () => {
	await resetStorage();
	const handle = defineApp({
		...whisperingDefinition,
		runtime: {
			...browser,
			sqlite: testSqlite,
			blobs: testBlobs,
		},
		ai: { runtime: null, account: null },
	});
	expect(
		(await indexedDB.databases()).filter(({ name }) =>
			name?.startsWith(`epicenter/${APPS.WHISPERING.id}/`),
		),
	).toEqual([]);
	expect(handle.id).toBe(APPS.WHISPERING.id);
});

test('settings recover application defaults, notify, and survive a reopen', async () => {
	await resetStorage();
	{
		const account = announcingAccount('alice');
		const openedApp = await openWhispering(account);
		const app = createWhisperingDomains({
			openedApp,
			data: openedApp.account!.personal,
		});

		// Chosen by the application, applied by a read, never stored.
		expect(app.settings.get('transcriptionModel')).toBe('');
		expect(app.settings.get('recordingPausePlayback')).toBe(false);
		expect(app.settings.get('soundManualStart')).toBe(true);

		let notifications = 0;
		const stop = app.settings.subscribe(() => {
			notifications += 1;
		});
		app.settings.set('recordingPausePlayback', true);
		expect(app.settings.get('recordingPausePlayback')).toBe(true);
		expect(notifications).toBeGreaterThan(0);
		stop();
		await Bun.sleep(10);

		app[Symbol.dispose]();
		await openedApp.close();
	}

	// The same account, opened again on the same device: settings live on the
	// replica now, so surviving a reopen is the replica being found and reused
	// rather than a second document being minted underneath it. It is also the
	// close above being real: a lock still held would answer `AlreadyOpen`.
	const account = announcingAccount('alice');
	const openedApp = await openWhispering(account);
	const reopened = createWhisperingDomains({
		openedApp,
		data: openedApp.account!.personal,
	});

	expect(reopened.settings.get('recordingPausePlayback')).toBe(true);

	reopened[Symbol.dispose]();
	await openedApp.close();
});

test('the domains stop reading the store once they are disposed', async () => {
	// Disposal is on the value `createWhisperingDomains` returns and not on
	// `WhisperingApp`, so the session that built the domains is the only thing
	// that can end them: a component reading the app through context has no
	// `[Symbol.dispose]` to reach for.
	await resetStorage();
	const account = announcingAccount('alice');
	const openedApp = await openWhispering(account);
	const app = createWhisperingDomains({
		openedApp,
		data: openedApp.account!.personal,
	});

	app[Symbol.dispose]();
	let notifications = 0;
	app.settings.subscribe(() => {
		notifications += 1;
	});
	openedApp.device.kv.update({ recordingPausePlayback: true });
	await Bun.sleep(10);

	expect(notifications).toBe(0);
	await openedApp.close();
});
