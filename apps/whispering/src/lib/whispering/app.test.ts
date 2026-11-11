/**
 * Whispering app acquisition tests.
 *
 * The device document opens for every page lifetime and holds this machine's
 * settings; the boot auth snapshot chooses whether an account replica also
 * opens and takes over the portable work (ADR-0233). These tests cover that
 * boot choice and which document supplies work and settings.
 *
 * Key behaviors:
 * - Signed-out work uses one device document without account traffic
 * - Settings recover application defaults and survive a restart
 * - Settings remain readable from the device document after an account opens
 * - Recordings written signed out stay on the device and are not shown to a
 *   signed-in generation, which reads the account replica instead
 * - Signed-in recording writes produce an outbound sync push
 * - A pre-aborted boot rejects before creating a database
 *
 * Fake IndexedDB supplies browser storage. The signed-in write test captures
 * outgoing socket frames, but the fake has no server to prove delivery.
 */
import 'fake-indexeddb/auto';
import { installTestLocks } from '@epicenter/data/test-locks';

installTestLocks();

import { expect, test } from 'bun:test';
import { decodeFrame } from '@epicenter/data/sync';
import { InstantString } from '@epicenter/field';

// The recipes domain IS reactive state, so the runes are shimmed to their
// non-reactive meaning (the pattern the other runtime tests use). These
// assertions read imperatively: the question is which document a write landed
// in, not whether a view recomputed.
(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
	<TValue>(value: TValue) => value,
	{ by: <TValue>(derive: () => TValue) => derive() },
);

import type { AuthClient } from '@epicenter/auth';
import type { BlobStore } from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { whisperingDefinition } from '../workspace';
import { openWhisperingApp, type WhisperingAppDependencies } from './app';

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
 * A socket that opens for signed-in boot and reports its outgoing frames.
 */
function createFakeSocket(
	onSend: (bytes: Uint8Array) => void = () => undefined,
) {
	const listeners = new Map<string, Set<(event: unknown) => void>>();
	const socket = {
		binaryType: 'blob' as BinaryType,
		addEventListener(type: string, listener: (event: unknown) => void) {
			const set = listeners.get(type) ?? new Set();
			set.add(listener);
			listeners.set(type, set);
		},
		send: onSend,
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
 * The whole of what the app reads from auth: its boot state, the server's
 * base URL, and `openWebSocket`. Everything else throws, so a test fails
 * loudly if the app starts reaching further.
 */
function createFakeAuth({
	status,
	principalId = 'principal-under-test',
	onFetch = () => undefined,
	openWebSocket = () => {
		throw new Error('this generation must not dial');
	},
}: {
	status: 'signed-out' | 'signed-in';
	principalId?: string;
	onFetch?: () => void;
	openWebSocket?: () => Promise<WebSocket>;
}): AuthClient {
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
		onFetch();
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
		state: status === 'signed-out' ? { status } : { status, principalId },
		connection: {
			baseURL: 'https://api.test',
			status: 'connected',
			onChange: () => () => undefined,
		},
		onStateChange: () => () => undefined,
		startSignIn: unused,
		signOut: unused,
		fetch: generations,
		getProfile: unused,
		openWebSocket,
		[Symbol.dispose]: () => undefined,
	} as unknown as AuthClient;
}

/**
 * An auth for one account whose every dial simply connects.
 *
 * There is nothing for a dial to announce any more: a replica used to be
 * unavailable until the authority named the document it belonged to, and the
 * generation is in the address now (ADR-0292).
 */
function announcingAuth(
	principalId: string,
	onSend?: (bytes: Uint8Array) => void,
): AuthClient {
	return createFakeAuth({
		status: 'signed-in',
		principalId,
		openWebSocket: async () => {
			const fake = createFakeSocket(onSend);
			setTimeout(() => fake.open(), 0);
			return fake.socket;
		},
	});
}

function dependencies(auth: AuthClient): WhisperingAppDependencies {
	return {
		auth,
		blobs: { local, remote: null },
		reportBackgroundError: () => undefined,
	};
}

/** The whole create input; only the title matters to these tests. */
function recordingFields(title: string) {
	return {
		audioBlobId: 'blob_aaaaaaaaaaaaaaaaaaaaa' as never,
		title,
		recordedAt: InstantString.fromDate(new Date('2026-08-10T00:00:00.000Z')),
		recordedAtZone: 'UTC',
		transcript: '',
		polishedTranscript: null,
		duration: null,
	};
}

test('signed-out work uses only device storage without account traffic', async () => {
	await resetStorage();
	let requests = 0;
	let dials = 0;
	const auth = createFakeAuth({
		status: 'signed-out',
		onFetch: () => {
			requests += 1;
		},
		openWebSocket: async () => {
			dials += 1;
			throw new Error('signed-out boot must not dial');
		},
	});
	await using app = await openWhisperingApp(dependencies(auth));

	expect(app.syncStatus()).toBeUndefined();
	expect(app.recordings.count).toBe(0);
	expect(app.recipes.count).toBe(0);
	app.recordings.create(recordingFields('device only'));
	await Bun.sleep(10);
	expect(app.recordings.count).toBe(1);

	const names = (await indexedDB.databases()).map(({ name }) => name);
	expect(names).toContain(
		`epicenter/v2/${whisperingDefinition.id}/local/gen/1`,
	);
	expect(names.some((name) => name?.includes('/account/'))).toBe(false);
	expect(requests).toBe(0);
	expect(dials).toBe(0);
});

test('settings recover application defaults and survive a restart', async () => {
	await resetStorage();
	{
		await using app = await openWhisperingApp(
			dependencies(createFakeAuth({ status: 'signed-out' })),
		);
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
	}

	await using reopened = await openWhisperingApp(
		dependencies(createFakeAuth({ status: 'signed-out' })),
	);
	expect(reopened.settings.get('recordingAutoUpload')).toBe(true);
});

test('device settings remain readable when an account opens', async () => {
	await resetStorage();
	{
		await using signedOut = await openWhisperingApp(
			dependencies(createFakeAuth({ status: 'signed-out' })),
		);
		signedOut.settings.set('recordingAutoUpload', true);
		signedOut.recordings.create(recordingFields('written on this device'));
		await Bun.sleep(10);
	}

	await using signedIn = await openWhisperingApp(
		dependencies(announcingAuth('alice')),
	);
	// Signing in still reads the setting written while signed out.
	expect(signedIn.settings.get('recordingAutoUpload')).toBe(true);
	// The work is portable, so a signed-in generation reads the account replica.
	// The account replica has no local copy of the device recording.
	expect(signedIn.recordings.count).toBe(0);
});

test('device work is still there after signing back out', async () => {
	await resetStorage();
	{
		await using signedOut = await openWhisperingApp(
			dependencies(createFakeAuth({ status: 'signed-out' })),
		);
		signedOut.recordings.create(recordingFields('written on this device'));
		await Bun.sleep(10);
	}
	{
		await using signedIn = await openWhisperingApp(
			dependencies(announcingAuth('alice')),
		);
		signedIn.recordings.create(recordingFields('written on the account'));
		await Bun.sleep(10);
	}

	await using signedOutAgain = await openWhisperingApp(
		dependencies(createFakeAuth({ status: 'signed-out' })),
	);
	expect(signedOutAgain.recordings.sorted.map(({ title }) => title)).toEqual([
		'written on this device',
	]);
});

test('signed-in recording writes send a sync push after the socket opens', async () => {
	await resetStorage();
	const sent: Uint8Array[] = [];
	const outgoing = Promise.withResolvers<Uint8Array>();
	await using app = await openWhisperingApp(
		dependencies(
			announcingAuth('alice', (bytes) => {
				sent.push(bytes);
				outgoing.resolve(bytes);
			}),
		),
	);
	await Bun.sleep(10);
	expect(app.syncStatus()?.connected).toBe(true);
	expect(sent).toEqual([]);

	app.recordings.create(recordingFields('portable recording'));
	await outgoing.promise;
	const pushes = sent
		.map((bytes) => expectOk(decodeFrame(bytes)))
		.filter((frame) => frame.kind === 'push');
	expect(pushes).toHaveLength(1);
	expect(pushes[0]?.bytes.length).toBeGreaterThan(0);
});

test('a pre-aborted boot rejects before creating a database', async () => {
	await resetStorage();
	const controller = new AbortController();
	controller.abort(new Error('root unmounted'));

	await expect(
		openWhisperingApp(dependencies(createFakeAuth({ status: 'signed-out' })), {
			signal: controller.signal,
		}),
	).rejects.toThrow('root unmounted');
	expect(await indexedDB.databases()).toEqual([]);
});
