/** Real editor, authenticated sockets, IndexedDB, and document reload across replacement. */
import assert from 'node:assert/strict';
import { syncEngineOf } from '@epicenter/app/data';
import { InstantString } from '@epicenter/app/field';
import { openMemory } from '@epicenter/app/memory';
import type { CurrentAuthority, Frame } from '@epicenter/app/sync';
import * as Y from '@y/y';
import type { Page, WebSocketRoute } from 'playwright';
import { expectOk } from 'wellcrafted/testing';
import type { BrowserDurableSchema } from '../../../packages/app/src/data/store/idb-updates.js';
import { decodeFrame } from '../../../packages/app/src/data/sync/frames.js';
import { honeycrispDefinition } from '../src/lib/data.js';

/** Async service binding for the actual authority; payloads stay authority-owned. */
export type LibraryTestOperator = {
	capture(): Promise<ReturnType<CurrentAuthority['capture']>>;
	activate(
		request: Parameters<CurrentAuthority['prepareActivation']>[0],
	): Promise<
		ReturnType<
			Awaited<ReturnType<CurrentAuthority['prepareActivation']>>['activate']
		>
	>;
};

type JourneyWindow = Window & {
	journey?: {
		invalidating?: boolean;
		releaseInvalidation?: () => void;
		content: { setAttr(name: string, value: boolean): void };
		delayedCallbacks: (() => void)[];
	};
};

const cacheSuffix = '/shared/current';

async function cacheState(page: Page) {
	return page.evaluate(async (suffix) => {
		const name = (await indexedDB.databases()).find((entry) =>
			entry.name?.endsWith(suffix),
		)?.name;
		if (!name) throw new Error('Shared cache was never opened');
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(name);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			const transaction = database.transaction(['header', 'updates']);
			const header = transaction.objectStore('header').get('generation');
			const updates: IDBRequest<BrowserDurableSchema['updates']['value'][]> =
				transaction.objectStore('updates').getAll();
			await new Promise((resolve, reject) => {
				transaction.oncomplete = resolve;
				transaction.onabort = () => reject(transaction.error);
			});
			return {
				generation: (header.result as number | undefined) ?? null,
				rows: updates.result.length,
				pending: updates.result.filter((entry) => entry.authoritySeq == null)
					.length,
			};
		} finally {
			database.close();
		}
	}, cacheSuffix);
}

async function settled(page: Page, generation?: number) {
	for (let attempt = 0; attempt < 150; attempt++) {
		const state = await cacheState(page);
		if (
			state.generation !== null &&
			state.pending === 0 &&
			(generation === undefined || state.generation === generation)
		)
			return state;
		await Bun.sleep(100);
	}
	throw new Error('The browser outbox did not drain');
}

async function monitor(page: Page, origin: string) {
	type SocketRecord = {
		library: string | null;
		generation: number;
		frames: { direction: 'sent' | 'received'; kind: Frame['kind'] }[];
		socket: WebSocketRoute;
		server?: WebSocketRoute;
	};
	const network: {
		offline: boolean;
		failDownload: boolean;
		holdGeneration?: number;
		heldFrames: (() => void)[];
		beforeRetirement?: () => Promise<void>;
		sockets: SocketRecord[];
	} = {
		offline: false,
		failDownload: false,
		holdGeneration: undefined,
		heldFrames: [],
		beforeRetirement: undefined,
		sockets: [],
	};
	await page.addInitScript(() => {
		sessionStorage.setItem(
			'journey.documents',
			String(Number(sessionStorage.getItem('journey.documents') ?? 0) + 1),
		);
	});
	await page.route(`${origin}/**`, (route) => {
		if (
			network.offline ||
			(network.failDownload && route.request().url().includes('/current'))
		)
			return route.abort();
		return route.continue();
	});
	await page.routeWebSocket(
		`${origin.replace('http:', 'ws:')}/**`,
		(socket) => {
			const url = new URL(socket.url());
			const record: SocketRecord = {
				library: url.searchParams.get('library'),
				generation: Number(url.searchParams.get('generation')),
				frames: [],
				socket,
				server: undefined,
			};
			network.sockets.push(record);
			if (network.offline) {
				void socket.close();
				return;
			}
			const server = socket.connectToServer();
			record.server = server;
			socket.onMessage((message) => {
				assert(typeof message !== 'string', 'Sync frames must be binary');
				const decoded = decodeFrame(new Uint8Array(message));
				assert.equal(decoded.error, null);
				record.frames.push({ direction: 'sent', kind: decoded.data.kind });
				server.send(message);
			});
			server.onMessage(async (message) => {
				assert(typeof message !== 'string', 'Sync frames must be binary');
				const decoded = decodeFrame(new Uint8Array(message));
				assert.equal(decoded.error, null);
				record.frames.push({ direction: 'received', kind: decoded.data.kind });
				if (
					record.library === 'shared' &&
					record.generation === network.holdGeneration
				) {
					network.heldFrames.push(() => socket.send(message));
					return;
				}
				if (decoded.data.kind === 'retired') await network.beforeRetirement?.();
				socket.send(message);
			});
		},
	);
	await page.reload();
	await page.getByRole('button', { name: 'New note', exact: true }).waitFor();
	return network;
}

async function documents(page: Page) {
	return page.evaluate(() =>
		Number(sessionStorage.getItem('journey.documents')),
	);
}

/** Pause or abort the real invalidation transaction, without replacing the backing. */
async function interruptInvalidation(page: Page, mode: 'pause' | 'abort') {
	await page.evaluate(
		({ suffix, mode }) => {
			const journey = (window as JourneyWindow).journey;
			if (!journey) throw new Error('Retirement observation was not installed');
			const original = IDBObjectStore.prototype.clear;
			IDBObjectStore.prototype.clear = function (...args) {
				const request = Reflect.apply(original, this, args);
				if (
					this.name !== 'header' ||
					!this.transaction.db.name.endsWith(suffix)
				)
					return request;
				IDBObjectStore.prototype.clear = original;
				journey.invalidating = true;
				if (mode === 'abort') {
					this.transaction.abort();
					return request;
				}
				const transaction = this.transaction;
				let held = true;
				journey.releaseInvalidation = () => {
					held = false;
				};
				function keepAlive() {
					transaction.objectStore('updates').get(1).onsuccess = () => {
						if (held) keepAlive();
					};
				}
				keepAlive();
				return request;
			};
		},
		{ suffix: cacheSuffix, mode },
	);
}

async function watchRetirement(page: Page) {
	await page.evaluate(async () => {
		const path = '/src/lib/application.ts';
		const { app, data, departure }: typeof import('../src/lib/application.js') =
			await import(path);
		if (!app?.account || !data)
			throw new Error('Expected an opened account App');
		const note = data.tables.notes.rows[0];
		if (!note) throw new Error('Expected a note');
		(window as JourneyWindow).journey = {
			content: note.content,
			delayedCallbacks: [],
		};
		void app.libraryReplaced!.then(() => {
			let refused = false;
			try {
				data.tables.notes.update(note.id, { title: 'Retired write' });
			} catch {
				refused = true;
			}
			sessionStorage.setItem('journey.write-refused', String(refused));
		});
		departure.onChange(() => {
			if (departure.state.phase === 'retired')
				sessionStorage.setItem('journey.closed-before-reload', 'true');
		});
	});
}

async function freshReplacement(
	captured: Awaited<ReturnType<LibraryTestOperator['capture']>>,
) {
	// Author valid replacement state independently; never replay the old lineage.
	await using replacement = await openMemory(honeycrispDefinition);
	const at = InstantString.fromDate(new Date('2026-09-17T00:00:00.000Z'));
	const note = replacement.tables.notes.create({
		folderId: null,
		title: 'Replacement from Bob',
		pinned: false,
		createdAt: at,
		updatedAt: at,
		deletedAt: null,
	});
	expectOk(
		honeycrispDefinition.tables.notes.content.rewrite(
			note.content,
			'Replacement from Bob',
		),
	);
	const bytes = syncEngineOf(replacement).encodeSnapshot();
	const oldWriters = Y.decodeStateVector(
		Y.encodeStateVectorFromUpdateV2(
			Y.mergeUpdatesV2([
				new Uint8Array(captured.snapshot.bytes),
				...captured.tail.map((entry) => new Uint8Array(entry.bytes)),
			]),
		),
	);
	const newWriters = Y.decodeStateVector(
		Y.encodeStateVectorFromUpdateV2(new Uint8Array(bytes)),
	);
	assert(newWriters.size > 0, 'Replacement must contain authored state');
	assert(
		[...newWriters.keys()].every((writer) => !oldWriters.has(writer)),
		'Replacement must have no preceding lineage',
	);
	return bytes;
}

export async function proveRetirement({
	alice,
	bob,
	origin,
	operator,
	openNote,
}: {
	alice: Page;
	bob: Page;
	origin: string;
	operator: LibraryTestOperator;
	openNote(page: Page, text: string): Promise<void>;
}) {
	const [a, b] = await Promise.all([
		monitor(alice, origin),
		monitor(bob, origin),
	]);
	await Promise.all([settled(alice), settled(bob)]);
	await openNote(alice, 'Shared note edited by Bob');
	await openNote(bob, 'Shared note edited by Bob');
	const before = await cacheState(alice);
	assert(before.generation !== null);

	// Only the authority connection is offline; the app bundle can still reload.
	a.offline = true;
	await Promise.all(
		a.sockets.flatMap(({ socket, server }) => [
			socket.close(),
			server?.close(),
		]),
	);
	await alice.locator('.ProseMirror').press('ControlOrMeta+A');
	await alice.locator('.ProseMirror').press('Backspace');
	await alice
		.locator('.ProseMirror')
		.pressSequentially('Offline work that must be retired');
	await alice.locator('.ProseMirror').blur();
	await alice
		.getByText('Offline work that must be retired', { exact: true })
		.first()
		.waitFor();
	await alice.waitForFunction(async () => {
		const path = '/src/lib/application.ts';
		const { data }: typeof import('../src/lib/application.js') = await import(
			path
		);
		return data?.tables.notes.rows.some(
			(note) => note.title === 'Offline work that must be retired',
		);
	});
	assert.equal(
		await alice.evaluate(async () => {
			const path = '/src/lib/application.ts';
			const { data }: typeof import('../src/lib/application.js') = await import(
				path
			);
			if (!data) throw new Error('Expected the selected Shared store');
			await data.persistence.flush();
			return data.persistence.get();
		}),
		'saved',
	);
	await alice.reload();
	await alice
		.getByText('Offline work that must be retired', { exact: true })
		.first()
		.waitFor();
	assert(
		(await cacheState(alice)).pending > 0,
		'Offline edit must be durably owed',
	);
	await openNote(alice, 'Offline work that must be retired');

	await bob.locator('.ProseMirror').press('ControlOrMeta+A');
	await bob.locator('.ProseMirror').press('Backspace');
	await bob.locator('.ProseMirror').pressSequentially('Replacement from Bob');
	await bob.locator('.ProseMirror').blur();
	await bob
		.getByText('Replacement from Bob', { exact: true })
		.first()
		.waitFor();
	await settled(bob);
	const captured = await operator.capture();
	const bytes = await freshReplacement(captured);
	const request = {
		operation: crypto.randomUUID(),
		expected: { generation: captured.generation, head: captured.head },
		bytes,
	};
	await Promise.all([watchRetirement(alice), watchRetirement(bob)]);
	const bobDocuments = await documents(bob);
	const activated = await operator.activate(request);
	assert.equal(activated.status, 'activated');
	assert.equal(activated.generation, before.generation + 1);
	assert.deepEqual(
		await operator.activate(request),
		activated,
		'Lost-response retry must return the receipt',
	);
	await bob.waitForFunction(
		(count) =>
			Number(sessionStorage.getItem('journey.documents')) === count + 1,
		bobDocuments,
	);
	await bob
		.getByText('Replacement from Bob', { exact: true })
		.first()
		.waitFor();
	assert(
		b.sockets.some(
			(socket) =>
				socket.generation === before.generation &&
				socket.frames.some((frame) => frame.kind === 'retired'),
		),
		'An already-open idle socket must learn retirement from its own authority',
	);
	await bob.getByRole('button', { name: 'New note', exact: true }).click();
	await bob.locator('.ProseMirror').press('ControlOrMeta+A');
	await bob.locator('.ProseMirror').press('Backspace');
	await bob
		.locator('.ProseMirror')
		.pressSequentially('Accepted after replacement');
	await bob.locator('.ProseMirror').blur();
	await bob
		.getByText('Accepted after replacement', { exact: true })
		.first()
		.waitFor();
	await settled(bob);
	assert(
		(await operator.capture()).tail.length > 0,
		'Accepted post-replacement edits must still be in the tail',
	);
	a.holdGeneration = activated.generation;
	assert.equal((await cacheState(alice)).generation, before.generation);
	assert(
		(await cacheState(alice)).pending > 0,
		'Remote replacement cannot clear offline storage',
	);

	// Hold a real editor title timer until the retirement frame arrives.
	a.beforeRetirement = async () => {
		a.beforeRetirement = undefined;
		await alice.evaluate(() => {
			const journey = (window as JourneyWindow).journey;
			if (!journey) throw new Error('Retirement observation was not installed');
			const browserWindow: Window = window;
			const original = browserWindow.setTimeout;
			journey.delayedCallbacks = [];
			browserWindow.setTimeout = (callback, _delay, ...args) => {
				if (typeof callback !== 'function')
					throw new Error('Expected a timer callback');
				journey.delayedCallbacks.push(() => callback(...args));
				return original(() => {}, 60_000);
			};
			try {
				journey.content.setAttr('retirement-test', true);
			} finally {
				browserWindow.setTimeout = original;
			}
			if (journey.delayedCallbacks.length === 0)
				throw new Error('The actual editor did not queue a title callback');
		});
	};
	await interruptInvalidation(alice, 'pause');
	const aliceDocuments = await documents(alice);
	const reconnectStart = a.sockets.length;
	a.offline = false;
	await alice.waitForFunction(
		() => (window as JourneyWindow).journey?.invalidating === true,
	);
	assert.equal(
		await documents(alice),
		aliceDocuments,
		'Reload must await durable invalidation',
	);
	await alice.waitForFunction(
		() => document.querySelector('.ProseMirror') === null,
	);
	assert.equal(
		await alice.evaluate(() => sessionStorage.getItem('journey.write-refused')),
		'true',
	);
	assert(
		(
			await alice.evaluate(
				async () => (await navigator.locks.query()).held ?? [],
			)
		).some((lock) => lock.name?.startsWith('epicenter.store:library:')),
		'Library claim must remain held during invalidation',
	);
	await alice.evaluate(() => {
		const journey = (window as JourneyWindow).journey;
		if (!journey?.releaseInvalidation)
			throw new Error('Invalidation was not paused');
		for (const callback of journey.delayedCallbacks) callback();
		journey.releaseInvalidation();
	});
	await alice.waitForFunction(
		(count) =>
			Number(sessionStorage.getItem('journey.documents')) === count + 1,
		aliceDocuments,
	);
	await alice
		.getByText('Replacement from Bob', { exact: true })
		.first()
		.waitFor();
	await alice
		.getByText('Accepted after replacement', { exact: true })
		.first()
		.waitFor();
	assert.equal(
		a.sockets.some(
			(socket) =>
				socket.generation === activated.generation &&
				socket.frames.some((frame) => frame.direction === 'sent'),
		),
		false,
		'Full captured contents must be usable before the new socket admits the sender',
	);
	a.holdGeneration = undefined;
	for (const forward of a.heldFrames.splice(0)) forward();
	assert.equal(
		await alice
			.getByText('Offline work that must be retired', { exact: true })
			.count(),
		0,
	);
	assert.equal(
		await alice.evaluate(() =>
			sessionStorage.getItem('journey.closed-before-reload'),
		),
		'true',
	);
	const reopened = await settled(alice);
	assert.equal(reopened.generation, activated.generation);
	assert.equal(reopened.pending, 0);
	const staleConnections = a.sockets
		.slice(reconnectStart)
		.filter(
			(socket) =>
				socket.library === 'shared' && socket.generation === before.generation,
		);
	assert(staleConnections.length > 0);
	for (const socket of staleConnections) {
		assert.equal(
			socket.frames.some((frame) => frame.direction === 'sent'),
			false,
			'A stale reconnect must upload nothing',
		);
		assert.deepEqual(socket.frames, [
			{ direction: 'received', kind: 'retired' },
		]);
	}
	console.log(
		'PASS: offline edit survives reopen; replacement retires idle B; stale A sends no outbox, stops editor callbacks, retains claim, invalidates, and reloads complete replacement contents before socket admission',
	);

	// An aborted invalidation retains the fenced App and claim; retry can finish.
	await openNote(alice, 'Replacement from Bob');
	await watchRetirement(alice);
	await interruptInvalidation(alice, 'abort');
	const retryDocuments = await documents(alice);
	const next = await operator.capture();
	const again = await freshReplacement(next);
	assert.equal(
		(
			await operator.activate({
				operation: crypto.randomUUID(),
				expected: { generation: next.generation, head: next.head },
				bytes: again,
			})
		).status,
		'activated',
	);
	await alice.waitForFunction(async () => {
		const path = '/src/lib/application.ts';
		const { departure }: typeof import('../src/lib/application.js') =
			await import(path);
		return departure.canRetryClose;
	});
	assert.equal(await documents(alice), retryDocuments);
	assert.equal((await cacheState(alice)).generation, activated.generation);
	assert(
		(
			await alice.evaluate(
				async () => (await navigator.locks.query()).held ?? [],
			)
		).some((lock) => lock.name?.startsWith('epicenter.store:library:')),
	);
	a.failDownload = true;
	await alice.getByRole('button', { name: 'Try again', exact: true }).click();
	await alice.waitForFunction(
		(count) =>
			Number(sessionStorage.getItem('journey.documents')) === count + 1,
		retryDocuments,
	);
	await alice.getByRole('button', { name: 'Try again', exact: true }).waitFor();
	assert.deepEqual(await cacheState(alice), {
		generation: null,
		rows: 0,
		pending: 0,
	});
	assert.equal(await documents(alice), retryDocuments + 1);
	await alice.waitForTimeout(1000);
	assert.equal(
		await documents(alice),
		retryDocuments + 1,
		'Download failure must not cause a reload loop',
	);
	a.failDownload = false;
	await alice.getByRole('button', { name: 'Try again', exact: true }).click();
	await alice
		.getByText('Replacement from Bob', { exact: true })
		.first()
		.waitFor();
	assert.equal((await settled(alice)).generation, activated.generation + 1);
	await settled(bob, activated.generation + 1);
	console.log(
		'PASS: failed invalidation retains the old claim; retry clears it; failed replacement download leaves no cache and recovers through normal bootstrap retry',
	);

	await alice.unroute(`${origin}/**`);
	await bob.unroute(`${origin}/**`);
}
