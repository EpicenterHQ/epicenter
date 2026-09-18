/** Real editor, authenticated sockets, IndexedDB, and document reload across replacement. */
import assert from 'node:assert/strict';
import { syncEngineOf } from '@epicenter/app/data';
import { InstantString } from '@epicenter/app/field';
import { openMemory } from '@epicenter/app/memory';
import type { CurrentAuthority, Frame } from '@epicenter/app/sync';
import * as Y from '@y/y';
import type { Page, WebSocketRoute } from 'playwright';
import { expectOk } from 'wellcrafted/testing';
import { decodeFrame } from '../../../packages/app/src/data/sync/frames.js';
import { honeycrispDefinition } from '../src/lib/data.js';

/** Async service binding for the actual authority; payloads stay authority-owned. */
export type AppTestOperator = {
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
	journey?: { invalidating?: boolean; releaseInvalidation?: () => void };
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
			const updates: IDBRequest<Array<{ authoritySeq: number | null }>> =
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
		scope: string | null;
		generation: number;
		frames: { direction: 'sent' | 'received'; kind: Frame['kind'] }[];
		socket: WebSocketRoute;
		server?: WebSocketRoute;
	};
	const network: {
		failDownload: boolean;
		sockets: SocketRecord[];
	} = {
		failDownload: false,
		sockets: [],
	};

	await page.route(`${origin}/**`, (route) => {
		if (network.failDownload && route.request().url().includes('/current'))
			return route.abort();
		return route.continue();
	});
	await page.routeWebSocket(
		`${origin.replace('http:', 'ws:')}/**`,
		(socket) => {
			const url = new URL(socket.url());
			const record: SocketRecord = {
				scope: url.searchParams.get('scope'),
				generation: Number(url.searchParams.get('generation')),
				frames: [],
				socket,
				server: undefined,
			};
			network.sockets.push(record);

			const server = socket.connectToServer();
			record.server = server;
			socket.onMessage((message) => {
				assert(typeof message !== 'string', 'Sync frames must be binary');
				const decoded = decodeFrame(new Uint8Array(message));
				assert.equal(decoded.error, null);
				record.frames.push({ direction: 'sent', kind: decoded.data.kind });
				server.send(message);
			});
			server.onMessage((message) => {
				assert(typeof message !== 'string', 'Sync frames must be binary');
				const decoded = decodeFrame(new Uint8Array(message));
				assert.equal(decoded.error, null);
				record.frames.push({ direction: 'received', kind: decoded.data.kind });

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

async function freshReplacement(
	captured: Awaited<ReturnType<AppTestOperator['capture']>>,
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
	operator: AppTestOperator;
	openNote(page: Page, text: string): Promise<void>;
}) {
	const networks = await Promise.all([
		monitor(alice, origin),
		monitor(bob, origin),
	]);
	await Promise.all([settled(alice), settled(bob)]);
	await openNote(alice, 'Alice private note');
	const before = await cacheState(alice);
	assert(before.generation !== null);
	await alice.evaluate(() => {
		(window as JourneyWindow).journey = {};
	});
	await interruptInvalidation(alice, 'pause');
	const aliceDocuments = await documents(alice);
	const captured = await operator.capture();
	const request = {
		operation: crypto.randomUUID(),
		expected: { generation: captured.generation, head: captured.head },
		bytes: await freshReplacement(captured),
	};
	const activated = await operator.activate(request);
	assert.equal(activated.status, 'activated');
	assert.equal(activated.generation, before.generation + 1);
	assert.deepEqual(
		await operator.activate(request),
		activated,
		'Lost-response retry returns the receipt',
	);
	await alice.waitForFunction(
		() => (window as JourneyWindow).journey?.invalidating === true,
	);
	await alice.waitForFunction(
		() => document.querySelector('.ProseMirror') === null,
	);
	assert.equal(await documents(alice), aliceDocuments);
	assert(
		(
			await alice.evaluate(
				async () => (await navigator.locks.query()).held ?? [],
			)
		).some((lock) => lock.name?.startsWith('epicenter.store:library:')),
		'The acquired Shared store keeps its claim while invalidation is pending',
	);
	assert.equal(
		await alice
			.getByRole('button', { name: 'Reload Honeycrisp', exact: true })
			.count(),
		0,
		'Recovery must await durable invalidation',
	);
	await alice.evaluate(() =>
		(window as JourneyWindow).journey?.releaseInvalidation?.(),
	);
	await alice
		.getByRole('button', { name: 'Reload Honeycrisp', exact: true })
		.click();
	await alice
		.getByText('Alice private note', { exact: true })
		.first()
		.waitFor();
	assert.equal(await documents(alice), aliceDocuments + 1);
	assert.equal((await settled(alice)).generation, activated.generation);
	await bob
		.getByRole('button', { name: 'Reload Honeycrisp', exact: true })
		.click();
	await bob.getByText('Bob private note', { exact: true }).first().waitFor();
	await settled(bob, activated.generation);
	assert(
		networks.every((network) =>
			network.sockets.some(
				(socket) =>
					socket.scope === 'shared' &&
					socket.frames.some((frame) => frame.kind === 'retired'),
			),
		),
		'An acquired Shared store retires the whole App even while Personal is displayed',
	);

	await openNote(alice, 'Alice private note');
	await alice.evaluate(() => {
		(window as JourneyWindow).journey = {};
	});
	await interruptInvalidation(alice, 'abort');
	const retryDocuments = await documents(alice);
	const next = await operator.capture();
	assert.equal(
		(
			await operator.activate({
				operation: crypto.randomUUID(),
				expected: { generation: next.generation, head: next.head },
				bytes: await freshReplacement(next),
			})
		).status,
		'activated',
	);
	await alice
		.getByRole('button', { name: 'Reload Honeycrisp', exact: true })
		.waitFor();
	assert.equal(await documents(alice), retryDocuments);
	assert.equal(await alice.locator('.ProseMirror').count(), 0);
	assert.equal((await cacheState(alice)).generation, activated.generation);
	assert(
		(
			await alice.evaluate(
				async () => (await navigator.locks.query()).held ?? [],
			)
		).some((lock) => lock.name?.startsWith('epicenter.store:library:')),
		'Failed invalidation retains unsafe ownership until document teardown',
	);
	networks[0]!.failDownload = true;
	await alice.getByRole('button', { name: /Reload/, exact: true }).click();
	await alice.getByRole('button', { name: /Reload/, exact: true }).waitFor();
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
	networks[0]!.failDownload = false;
	await alice.getByRole('button', { name: /Reload/, exact: true }).click();
	await alice
		.getByText('Alice private note', { exact: true })
		.first()
		.waitFor();
	await settled(alice, activated.generation + 1);
	await bob
		.getByRole('button', { name: 'Reload Honeycrisp', exact: true })
		.click();
	await settled(bob, activated.generation + 1);
	console.log(
		'PASS: undisplayed Shared retirement unmounts the Personal editor; invalidation retains claims; failed cleanup requires document teardown; reopening preserves Personal notes',
	);
	await alice.unroute(`${origin}/**`);
	await bob.unroute(`${origin}/**`);
}
