/**
 * Browser Epicenter Adapter Tests
 *
 * Drives the page proxy and worker host in-process without a browser or OPFS.
 * Every fake port hop uses structured clone, while an in-memory SQLite store
 * exercises the real replica, Epicenter core, and row-document persistence.
 *
 * Key behaviors:
 * - typed table and value operations round-trip through worker RPC
 * - concurrent tabs observe and commit against one durable owner
 * - incremental row-document updates persist and deletion revokes handles
 * - sync attachment errors and owner disposal cross the RPC boundary
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type BrowserWorkerStore,
	createBrowserWorkerHost,
	type MessagePortLike,
} from './browser/worker.js';
import {
	type BrowserEpicenter,
	type ClientMessagePort,
	openBrowserEpicenter,
	type RuntimeBroadcastChannel,
} from './browser.js';
import { createEpicenter } from './epicenter.js';
import { defineTable, defineValue, optional } from './index.js';
import type { ExchangeRequest, ExchangeResponse } from './protocol/index.js';
import { openReplica } from './replica/index.js';

type MessageListener = (event: { data: never }) => void;

class FakeMessagePort {
	peer: FakeMessagePort | undefined;
	private readonly listeners = new Set<MessageListener>();

	postMessage(message: unknown): void {
		const cloned = structuredClone(message);
		queueMicrotask(() => this.peer?.emit(cloned));
	}

	addEventListener(_type: 'message', listener: MessageListener): void {
		this.listeners.add(listener);
	}

	start(): void {}

	close(): void {}

	private emit(message: unknown): void {
		for (const listener of this.listeners) {
			listener({ data: message as never });
		}
	}
}

function createPortPair(): {
	page: ClientMessagePort;
	worker: MessagePortLike;
} {
	const page = new FakeMessagePort();
	const worker = new FakeMessagePort();
	page.peer = worker;
	worker.peer = page;
	return {
		page: page as ClientMessagePort,
		worker: worker as MessagePortLike,
	};
}

class FakeBroadcastHub {
	readonly posted: unknown[] = [];
	private readonly channels = new Map<string, Set<FakeBroadcastChannel>>();

	create = (name: string): RuntimeBroadcastChannel => {
		const channel = new FakeBroadcastChannel(this, name);
		const peers = this.channels.get(name) ?? new Set();
		peers.add(channel);
		this.channels.set(name, peers);
		return channel;
	};

	post(source: FakeBroadcastChannel, name: string, message: unknown): void {
		const cloned = structuredClone(message);
		this.posted.push(cloned);
		for (const channel of this.channels.get(name) ?? []) {
			if (channel === source) continue;
			queueMicrotask(() =>
				channel.onmessage?.({ data: structuredClone(cloned) }),
			);
		}
	}

	remove(name: string, channel: FakeBroadcastChannel): void {
		const peers = this.channels.get(name);
		peers?.delete(channel);
		if (peers?.size === 0) this.channels.delete(name);
	}
}

class FakeBroadcastChannel implements RuntimeBroadcastChannel {
	onmessage: ((event: { data: unknown }) => void) | null = null;

	constructor(
		private readonly hub: FakeBroadcastHub,
		private readonly name: string,
	) {}

	postMessage(message: unknown): void {
		this.hub.post(this, this.name, message);
	}

	close(): void {
		this.hub.remove(this.name, this);
	}
}

function createStoreOwner() {
	let activeStores = 0;
	let openCount = 0;
	let disposeCount = 0;

	async function openStore(): Promise<BrowserWorkerStore> {
		if (activeStores !== 0) throw new Error('SQLite owner is already active');
		activeStores += 1;
		openCount += 1;
		const rawDatabase = new Database(':memory:');
		const database = createBunSqliteAdapter(rawDatabase);
		const opened = openReplica({ database });
		if (opened.error !== null) throw opened.error;
		const epicenter = createEpicenter({
			replica: opened.data,
			database,
			dispose: () => rawDatabase.close(),
		});
		return {
			epicenter,
			replica: opened.data,
			async dispose() {
				await epicenter[Symbol.asyncDispose]();
				activeStores -= 1;
				disposeCount += 1;
			},
		};
	}

	return {
		openStore,
		get activeStores() {
			return activeStores;
		},
		get openCount() {
			return openCount;
		},
		get disposeCount() {
			return disposeCount;
		},
	};
}

const notes = defineTable({
	key: 'so.epicenter.test.notes',
	fields: {
		title: field.string(),
		detail: optional(field.string()),
	},
});

const theme = defineValue({
	key: 'so.epicenter.test.theme',
	value: field.string(),
});

async function setup({
	exchangeTimeoutMs,
}: {
	exchangeTimeoutMs?: number;
} = {}) {
	const owner = createStoreOwner();
	const broadcasts = new FakeBroadcastHub();
	const host = createBrowserWorkerHost({
		openStore: owner.openStore,
		hostId: 'browser-test-host',
		...(exchangeTimeoutMs === undefined ? {} : { exchangeTimeoutMs }),
	});

	async function openTab(): Promise<BrowserEpicenter> {
		const { page, worker } = createPortPair();
		host.connect(worker);
		return openBrowserEpicenter({
			createSharedWorker: () => ({ port: page }),
			createBroadcastChannel: broadcasts.create,
		});
	}

	return { broadcasts, openTab, owner };
}

function bindTestData(epicenter: BrowserEpicenter) {
	return epicenter.bind({ tables: { notes }, values: { theme } });
}

test('page CRUD, scan, and value operations round-trip through the worker', async () => {
	const { openTab } = await setup();
	await using epicenter = await openTab();
	const data = bindTestData(epicenter);

	const created = await data.tables.notes.create({ title: 'First' });
	expect(created).toEqual({ id: expect.any(String), title: 'First' });
	expect(expectOk(await data.tables.notes.get(created.id))).toEqual(created);
	expectOk(
		await data.tables.notes.update(created.id, {
			title: 'Updated',
			detail: 'RPC',
		}),
	);
	expect((await data.tables.notes.scan()).rows).toEqual([
		{ id: created.id, title: 'Updated', detail: 'RPC' },
	]);

	await data.values.theme.set('dark');
	expect(expectOk(await data.values.theme.get())).toBe('dark');
	await data.values.theme.unset();
	expect(expectOk(await data.values.theme.get())).toBeUndefined();
	expect(await data.tables.notes.delete(created.id)).toBe(true);
	expect(expectOk(await data.tables.notes.get(created.id))).toBeUndefined();
});

test('a committed write invalidates subscribers in a second tab', async () => {
	const { broadcasts, openTab } = await setup();
	await using first = await openTab();
	await using second = await openTab();
	const firstData = bindTestData(first);
	const secondData = bindTestData(second);
	const observed: string[][] = [];
	const unsubscribe = secondData.tables.notes.subscribe((ids) => {
		observed.push(ids);
	});

	const created = await firstData.tables.notes.create({ title: 'Observed' });
	await waitFor(() => observed.flat().includes(created.id));
	expect(expectOk(await secondData.tables.notes.get(created.id))).toEqual(
		created,
	);
	expect(broadcasts.posted).toHaveLength(1);
	unsubscribe();
});

test('two tabs serialize writes and stream across internal RPC batches', async () => {
	const { openTab } = await setup();
	await using first = await openTab();
	await using second = await openTab();
	const firstNotes = bindTestData(first).tables.notes;
	const secondNotes = bindTestData(second).tables.notes;

	const created = await Promise.all(
		Array.from({ length: 104 }, (_, index) =>
			(index % 2 === 0 ? firstNotes : secondNotes).create({
				title: `Note ${index}`,
			}),
		),
	);
	const streamed = [];
	for await (const entry of firstNotes.entries()) {
		streamed.push(expectOk(entry));
	}
	expect(streamed).toHaveLength(104);
	expect(new Set(streamed.map(({ id }) => id))).toHaveLength(104);
	expect(streamed.map(({ title }) => title).sort()).toEqual(
		created.map(({ title }) => title).sort(),
	);
});

test('row documents persist incremental updates and revoke on row deletion', async () => {
	const { openTab } = await setup();
	await using first = await openTab();
	await using second = await openTab();
	const firstNotes = bindTestData(first).tables.notes;
	const secondNotes = bindTestData(second).tables.notes;
	const row = await firstNotes.create({ title: 'Document' });
	const firstDocument = await firstNotes.openDocument(row.id);
	firstDocument.get('content').insert(0, 'incremental');
	await firstDocument.whenDurable();

	const secondDocument = await secondNotes.openDocument(row.id);
	expect(secondDocument.get('content').toString()).toBe('incremental');
	secondDocument.get('content').insert(11, ' RPC');
	await secondDocument.whenDurable();
	await waitFor(
		() => firstDocument.get('content').toString() === 'incremental RPC',
	);

	await firstNotes.delete(row.id);
	await waitFor(() => {
		try {
			secondDocument.get('content');
			return false;
		} catch {
			return true;
		}
	});
	expect(() => firstDocument.get('content')).toThrow('revoked');
	expect(() => secondDocument.get('content')).toThrow('revoked');
	await firstDocument[Symbol.asyncDispose]();
	await secondDocument[Symbol.asyncDispose]();
});

test('attachSync refuses a second principal through RPC', async () => {
	const { openTab } = await setup();
	await using epicenter = await openTab();
	let firstExchanges = 0;
	let refusedExchanges = 0;
	const credentials = createMutableCredentials();

	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange(request) {
				firstExchanges += 1;
				return acknowledge(request);
			},
			credentials: credentials.provider,
		}),
	);
	const firstBeforeRefusal = firstExchanges;
	const refusal = expectErr(
		await epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'bob',
			exchange(request) {
				refusedExchanges += 1;
				return acknowledge(request);
			},
		}),
	);
	expect(refusal.name).toBe('WrongAttachment');

	await bindTestData(epicenter).tables.notes.create({
		title: 'Still attached',
	});
	await waitFor(() => firstExchanges > firstBeforeRefusal);
	expect(refusedExchanges).toBe(0);
	credentials.setAvailable(false);
	await waitFor(() => epicenter.syncStatus.state === 'authentication-required');
});

test('sync transport fails over when the last-attaching tab disconnects', async () => {
	const { openTab } = await setup();
	await using first = await openTab();
	const second = await openTab();
	let firstExchanges = 0;
	let secondExchanges = 0;

	expectOk(
		await first.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange(request) {
				firstExchanges += 1;
				return acknowledge(request);
			},
		}),
	);
	expectOk(
		await second.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange(request) {
				secondExchanges += 1;
				return acknowledge(request);
			},
		}),
	);
	const firstBeforeWrite = firstExchanges;
	const secondBeforeDisconnect = secondExchanges;

	await second[Symbol.asyncDispose]();
	await bindTestData(first).tables.notes.create({ title: 'Fail over' });
	await waitFor(() => firstExchanges > firstBeforeWrite);
	expect(secondExchanges).toBe(secondBeforeDisconnect);
});

test('sync retries the exact request through another tab when the selected transport stalls', async () => {
	const { openTab } = await setup({ exchangeTimeoutMs: 10 });
	await using first = await openTab();
	await using second = await openTab();
	let firstRequest: ExchangeRequest | undefined;
	let secondRequest: ExchangeRequest | undefined;
	let firstExchanges = 0;
	let secondExchanges = 0;
	let secondStalls = false;
	const credentials = createMutableCredentials();
	const secondCredentials = createMutableCredentials();

	expectOk(
		await first.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange(request) {
				firstExchanges += 1;
				firstRequest = request;
				return acknowledge(request);
			},
			credentials: credentials.provider,
		}),
	);
	expectOk(
		await second.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange(request) {
				secondExchanges += 1;
				secondRequest = request;
				return secondStalls
					? new Promise<ExchangeResponse>(() => undefined)
					: acknowledge(request);
			},
			credentials: secondCredentials.provider,
		}),
	);
	firstRequest = undefined;
	secondRequest = undefined;
	secondStalls = true;

	await bindTestData(first).tables.notes.create({ title: 'Retry exactly' });
	await waitFor(() => firstRequest !== undefined);
	expect(secondRequest).toEqual(firstRequest);
	const firstAfterFailover = firstExchanges;
	const secondAfterFailover = secondExchanges;
	await bindTestData(first).tables.notes.create({ title: 'Prefer healthy' });
	await waitFor(() => firstExchanges > firstAfterFailover);
	expect(secondExchanges).toBe(secondAfterFailover);

	credentials.setAvailable(false);
	secondCredentials.setAvailable(false);
	await waitFor(() => first.syncStatus.state === 'authentication-required');
});

test('a late reply re-enables the current sole sync transport', async () => {
	const { openTab } = await setup({ exchangeTimeoutMs: 10 });
	await using epicenter = await openTab();
	const requests: ExchangeRequest[] = [];

	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			async exchange(request) {
				requests.push(request);
				if (requests.length === 2) await Bun.sleep(25);
				return acknowledge(request);
			},
		}),
	);

	await bindTestData(epicenter).tables.notes.create({ title: 'Recover late' });
	await waitFor(
		() => requests.length >= 3 && epicenter.syncStatus.state === 'idle',
	);
	expect(requests[2]).toEqual(requests[1]);
});

test('a timed-out sole transport half-opens without losing credential state', async () => {
	const { openTab } = await setup({ exchangeTimeoutMs: 10 });
	await using epicenter = await openTab();
	const states: string[] = [];
	const requests: ExchangeRequest[] = [];
	const unsubscribe = epicenter.subscribeSyncStatus(({ state }) => {
		states.push(state);
	});
	let exchanges = 0;
	let stallNext = false;

	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange(request) {
				exchanges += 1;
				requests.push(request);
				if (stallNext) {
					stallNext = false;
					return new Promise<ExchangeResponse>(() => undefined);
				}
				return acknowledge(request);
			},
		}),
	);
	const beforeWrite = exchanges;
	stallNext = true;

	await bindTestData(epicenter).tables.notes.create({ title: 'Half open' });
	await waitFor(
		() => exchanges >= beforeWrite + 2 && epicenter.syncStatus.state === 'idle',
	);
	expect(requests.at(-1)).toEqual(requests.at(-2));
	expect(states).not.toContain('authentication-required');
	unsubscribe();
});

test('a quarantined transport recovers after its healthy peer disconnects', async () => {
	const { openTab } = await setup({ exchangeTimeoutMs: 10 });
	const second = await openTab();
	await using first = await openTab();
	let firstExchanges = 0;
	let secondExchanges = 0;
	let firstStalls = false;

	expectOk(
		await second.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange(request) {
				secondExchanges += 1;
				return acknowledge(request);
			},
		}),
	);
	expectOk(
		await first.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange(request) {
				firstExchanges += 1;
				if (firstStalls) {
					firstStalls = false;
					return new Promise<ExchangeResponse>(() => undefined);
				}
				return acknowledge(request);
			},
		}),
	);
	firstStalls = true;
	const secondBeforeFailover = secondExchanges;

	await bindTestData(first).tables.notes.create({ title: 'Quarantine first' });
	await waitFor(() => secondExchanges > secondBeforeFailover);
	const firstBeforeDisconnect = firstExchanges;
	await second[Symbol.asyncDispose]();
	await waitFor(
		() =>
			firstExchanges > firstBeforeDisconnect &&
			first.syncStatus.state === 'idle',
	);
});

test('disposing the last page releases ownership before a second open', async () => {
	const { openTab, owner } = await setup();
	const first = await openTab();
	expect(owner.activeStores).toBe(1);
	await first[Symbol.asyncDispose]();
	expect(owner.activeStores).toBe(0);
	expect(owner.disposeCount).toBe(1);

	await using second = await openTab();
	expect(second).toBeDefined();
	expect(owner.activeStores).toBe(1);
	expect(owner.openCount).toBe(2);
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline)
			throw new Error('Timed out waiting for browser RPC');
		await Bun.sleep(5);
	}
}

function acknowledge(request: ExchangeRequest): ExchangeResponse {
	return {
		...(request.batch === undefined
			? {}
			: {
					receipt: {
						seq: request.batch.seq,
						digest: request.batch.digest,
						appliedThrough: request.after,
					},
				}),
		through: request.after,
		records: [],
		next: null,
	};
}

function createMutableCredentials() {
	let available = true;
	let listener: (() => void) | undefined;
	return {
		provider: {
			get: () => (available ? 'credential' : undefined),
			subscribe(next: () => void) {
				listener = next;
				return () => {
					if (listener === next) listener = undefined;
				};
			},
		},
		setAvailable(next: boolean) {
			available = next;
			listener?.();
		},
	};
}
