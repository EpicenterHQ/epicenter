/**
 * Whispering's composition over one open replica.
 *
 * An authority mints every generation (ADR-0336), so this app has exactly one
 * document: the signed-in principal's replica. Opening it is the session's verb
 * and `$lib/epicenter.svelte.ts` owns the handle (ADR-0344), so these tests
 * compose the same two halves that module composes: `createEpicenter` with a
 * fake account, then `createWhisperingApp` over what the open handed back.
 *
 * Key behaviors:
 * - A signed-out account opens nothing at all, and says so through the session
 *   rather than by throwing
 * - Settings recover application defaults, notify, and survive a reopen
 * - Closing the session releases the store, so the next open finds it free
 *
 * `fake-indexeddb` supplies the browser store's storage; the socket is a fake
 * whose frames come from the real sync protocol (`encodeFrame`).
 */
import 'fake-indexeddb/auto';
import { installTestLocks } from '@epicenter/data/test-locks';

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

import { createEpicenter } from '@epicenter/app';
import type { Account } from '@epicenter/auth';
import type { BlobStore } from '@epicenter/blobs';
import { createBrowserBlobSources } from '@epicenter/blobs/browser';
import { APPS } from '@epicenter/constants/apps';
import { encodeFrame } from '@epicenter/data/sync';
import { asPrincipalId } from '@epicenter/principal';
import { Ok } from 'wellcrafted/result';
import { whisperingDefinition } from '../data';
import { createWhisperingApp } from './app';

const local: BlobStore = {
	async put() {
		return Ok(undefined);
	},
	async get() {
		return Ok(new Blob());
	},
	async stat() {
		return Ok({ size: 0, contentType: 'application/octet-stream' });
	},
	statMany(ids) {
		return Promise.all(ids.map((id) => local.stat(id)));
	},
	async delete() {
		return Ok(undefined);
	},
};

/**
 * Start each test from empty storage. IndexedDB outlives a test in this
 * process the way it outlives a page in a browser, and these tests each tell a
 * whole multi-generation story from a fresh install.
 */
async function resetStorage(): Promise<void> {
	for (const database of await indexedDB.databases()) {
		const name = database.name;
		if (name === undefined) continue;
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
}

/**
 * A socket the test scripts: listeners attach through the same
 * `addEventListener` surface the real driver uses, and `deliver` hands the
 * client a real protocol frame.
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
		deliver(frame: Parameters<typeof encodeFrame>[0]) {
			dispatch('message', { data: encodeFrame(frame).slice().buffer });
		},
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
	/**
	 * The generations collection, in memory, per fake account.
	 *
	 * The one HTTP surface a boot touches (ADR-0292): which generations exist,
	 * and one whole state to bootstrap from. Held per client so two fake
	 * accounts are two accounts.
	 */
	const held = new Map<number, Uint8Array>();
	const generations = async (
		input: Request | string | URL,
		init?: RequestInit,
	): Promise<Response> => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		const item = /\/generations\/(\d+)$/.exec(url.pathname);
		if (init?.method === 'POST') {
			const generation = held.size + 1;
			held.set(generation, new Uint8Array(init.body as ArrayBuffer));
			return Response.json({ generation, position: 1 });
		}
		if (item !== null) {
			const bytes = held.get(Number(item[1]));
			if (bytes === undefined) return new Response(null, { status: 404 });
			return new Response(bytes as unknown as BodyInit, {
				headers: { 'epicenter-log-position': '1' },
			});
		}
		return Response.json({ generations: [...held.keys()].sort() });
	};
	return {
		principalId: asPrincipalId(principalId),
		baseURL: 'https://api.test',
		fetch: generations,
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
	const handle = createEpicenter({
		appId: APPS.WHISPERING.id,
		definition: whisperingDefinition,
	});
	const session = handle.open(account);
	return { handle, session, account, opened: await session.opened };
}

test('constructing a handle opens no local database before an account session', async () => {
	await resetStorage();
	const handle = createEpicenter({
		appId: APPS.WHISPERING.id,
		definition: whisperingDefinition,
	});
	expect(await indexedDB.databases()).toEqual([]);
	await handle.close();
});

test('settings recover application defaults, notify, and survive a reopen', async () => {
	await resetStorage();
	{
		const { handle, opened, account } = await openWhispering(
			announcingAccount('alice'),
		);
		if (opened.error !== null) throw opened.error;
		const app = createWhisperingApp({
			data: opened.data,
			account,
			blobs: {
				local,
				remote: null,
				sources: createBrowserBlobSources(local),
				unscoped: null,
			},
		});

		// Chosen by the application, applied by a read, never stored.
		expect(app.settings.get('transcriptionService')).toBe('local');
		expect(app.settings.get('recordingAutoUpload')).toBe(false);
		expect(app.settings.get('soundManualStart')).toBe(true);

		let notifications = 0;
		const stop = app.settings.subscribe(() => {
			notifications += 1;
		});
		app.settings.set('recordingAutoUpload', true);
		expect(app.settings.get('recordingAutoUpload')).toBe(true);
		expect(notifications).toBeGreaterThan(0);
		stop();
		await Bun.sleep(10);

		app[Symbol.dispose]();
		await handle.close();
	}

	// The same account, opened again on the same device: settings live on the
	// replica now, so surviving a reopen is the replica being found and reused
	// rather than a second document being minted underneath it. It is also the
	// close above being real: a lock still held would answer `AlreadyOpen`.
	const { handle, opened, account } = await openWhispering(
		announcingAccount('alice'),
	);
	if (opened.error !== null) throw opened.error;
	const reopened = createWhisperingApp({
		data: opened.data,
		account,
		blobs: {
			local,
			remote: null,
			sources: createBrowserBlobSources(local),
			unscoped: null,
		},
	});

	expect(reopened.settings.get('recordingAutoUpload')).toBe(true);

	reopened[Symbol.dispose]();
	await handle.close();
});

test('the domains stop reading the store once they are disposed', async () => {
	// Disposal is on the value `createWhisperingApp` returns and not on
	// `WhisperingApp`, so the session that built the domains is the only thing
	// that can end them: a component reading the app through context has no
	// `[Symbol.dispose]` to reach for.
	await resetStorage();
	const { handle, opened, account } = await openWhispering(
		announcingAccount('alice'),
	);
	if (opened.error !== null) throw opened.error;
	const app = createWhisperingApp({
		data: opened.data,
		account,
		blobs: {
			local,
			remote: null,
			sources: createBrowserBlobSources(local),
			unscoped: null,
		},
	});

	app[Symbol.dispose]();
	let notifications = 0;
	app.settings.subscribe(() => {
		notifications += 1;
	});
	opened.data.kv.update({ recordingAutoUpload: true });
	await Bun.sleep(10);

	expect(notifications).toBe(0);
	await handle.close();
});
