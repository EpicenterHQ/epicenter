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
 * - sync failover cancels stale generations without overlapping page callbacks
 * - stalled sync attachment never blocks local RPC
 * - vanished pages are reclaimed whole after bounded worker-driven liveness probes
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
	type BrowserWorkerHealthPolicy,
	type ClientMessagePort,
	openBrowserEpicenter,
	type RuntimeBroadcastChannel,
} from './browser.js';
import type { RowDocument } from './documents.js';
import { createEpicenter, type Epicenter } from './epicenter.js';
import { defineTable, defineValue, optional } from './index.js';
import type { ExchangeRequest, ExchangeResponse } from './protocol/index.js';
import { openReplica } from './replica/index.js';

type MessageListener = (event: { data: never }) => void;

class FakeMessagePort {
	peer: FakeMessagePort | undefined;
	readonly sent: unknown[] = [];
	isClosed = false;
	private readonly listeners = new Set<MessageListener>();
	private readonly blockedIncomingTypes = new Set<string>();
	private readonly heldIncomingTypes = new Set<string>();
	private readonly heldIncoming = new Map<string, unknown[]>();
	private readonly throwingOutgoingTypes = new Set<string>();

	postMessage(message: unknown): void {
		if (
			typeof message === 'object' &&
			message !== null &&
			'type' in message &&
			typeof message.type === 'string' &&
			this.throwingOutgoingTypes.has(message.type)
		)
			throw new Error(`Fake port refused '${message.type}'`);
		const cloned = structuredClone(message);
		this.sent.push(cloned);
		setTimeout(() => this.peer?.emit(cloned), 0);
	}

	addEventListener(_type: 'message', listener: MessageListener): void {
		this.listeners.add(listener);
	}

	start(): void {}

	close(): void {
		this.isClosed = true;
		this.vanish();
	}

	vanish(): void {
		const peer = this.peer;
		this.peer = undefined;
		if (peer?.peer === this) peer.peer = undefined;
	}

	blockIncomingType(type: string): void {
		this.blockedIncomingTypes.add(type);
	}

	holdIncomingType(type: string): void {
		this.heldIncomingTypes.add(type);
	}

	releaseIncomingType(type: string): void {
		this.heldIncomingTypes.delete(type);
		const held = this.heldIncoming.get(type) ?? [];
		this.heldIncoming.delete(type);
		for (const message of held) setTimeout(() => this.emit(message), 0);
	}

	throwOutgoingType(type: string): void {
		this.throwingOutgoingTypes.add(type);
	}

	private emit(message: unknown): void {
		const type =
			typeof message === 'object' &&
			message !== null &&
			'type' in message &&
			typeof message.type === 'string'
				? message.type
				: undefined;
		if (type !== undefined && this.blockedIncomingTypes.has(type)) return;
		if (type !== undefined && this.heldIncomingTypes.has(type)) {
			const held = this.heldIncoming.get(type) ?? [];
			held.push(message);
			this.heldIncoming.set(type, held);
			return;
		}
		for (const listener of this.listeners) {
			listener({ data: message as never });
		}
	}
}

function createPortPair(): {
	page: ClientMessagePort;
	worker: MessagePortLike;
	vanish(): void;
	pageMessages: unknown[];
	sendWorkerMessage(message: unknown): void;
	workerMessages: unknown[];
	blockPageMessageType(type: string): void;
	holdPageMessageType(type: string): void;
	releasePageMessageType(type: string): void;
	throwWorkerMessageType(type: string): void;
	isWorkerClosed(): boolean;
} {
	const page = new FakeMessagePort();
	const worker = new FakeMessagePort();
	page.peer = worker;
	worker.peer = page;
	return {
		page: page as ClientMessagePort,
		worker: worker as MessagePortLike,
		vanish: () => page.vanish(),
		pageMessages: page.sent,
		sendWorkerMessage: (message) => worker.postMessage(message),
		workerMessages: worker.sent,
		blockPageMessageType: (type) => page.blockIncomingType(type),
		holdPageMessageType: (type) => page.holdIncomingType(type),
		releasePageMessageType: (type) => page.releaseIncomingType(type),
		throwWorkerMessageType: (type) => worker.throwOutgoingType(type),
		isWorkerClosed: () => worker.isClosed,
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

function createStoreOwner({
	transformDocument,
}: {
	transformDocument?(document: RowDocument): Promise<RowDocument>;
} = {}) {
	let activeStores = 0;
	let openCount = 0;
	let disposeCount = 0;
	let attachmentAtDisposal:
		| { deploymentId: string; principalId: string }
		| undefined;
	let steal: (() => void) | undefined;

	async function openStore({
		onStolen,
	}: {
		onStolen(): void;
	}): Promise<BrowserWorkerStore> {
		if (activeStores !== 0) throw new Error('SQLite owner is already active');
		steal = onStolen;
		activeStores += 1;
		openCount += 1;
		const rawDatabase = new Database(':memory:');
		const database = createBunSqliteAdapter(rawDatabase);
		const opened = openReplica({ database });
		if (opened.error !== null) throw opened.error;
		const localEpicenter = createEpicenter({
			replica: opened.data,
			database,
			dispose: () => rawDatabase.close(),
		});
		const epicenter =
			transformDocument === undefined
				? localEpicenter
				: interceptDocumentOpening(localEpicenter, transformDocument);
		return {
			epicenter,
			replica: opened.data,
			async dispose() {
				const metadata = opened.data.metadata();
				if (metadata.error === null) {
					attachmentAtDisposal = metadata.data.attachment;
				}
				await localEpicenter[Symbol.asyncDispose]();
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
		get attachmentAtDisposal() {
			return attachmentAtDisposal;
		},
		steal() {
			if (steal === undefined) throw new Error('Store is not open');
			steal();
		},
	};
}

function interceptDocumentOpening(
	epicenter: Epicenter,
	transformDocument: (document: RowDocument) => Promise<RowDocument>,
): Epicenter {
	return Object.freeze({
		bind(...args: unknown[]) {
			const bound = Reflect.apply(epicenter.bind, epicenter, args) as {
				tables: Record<string, object>;
				values: object;
			};
			const tables = Object.fromEntries(
				Object.entries(bound.tables).map(([key, lens]) => {
					const openDocument = Reflect.get(lens, 'openDocument', lens);
					return [
						key,
						Object.freeze({
							...lens,
							async openDocument(rowId: string) {
								const document = await Reflect.apply(openDocument, lens, [
									rowId,
								]);
								return transformDocument(document as RowDocument);
							},
						}),
					];
				}),
			);
			return Object.freeze({ ...bound, tables: Object.freeze(tables) });
		},
		attachSync: epicenter.attachSync,
		get syncStatus() {
			return epicenter.syncStatus;
		},
		subscribeSyncStatus: epicenter.subscribeSyncStatus,
		[Symbol.asyncDispose]: epicenter[Symbol.asyncDispose],
	}) as Epicenter;
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
	transportRetirementMs,
	clientLivenessIntervalMs,
	clientLivenessTimeoutMs,
	workerHealthPolicy,
}: {
	exchangeTimeoutMs?: number;
	transportRetirementMs?: number;
	clientLivenessIntervalMs?: number;
	clientLivenessTimeoutMs?: number;
	workerHealthPolicy?: BrowserWorkerHealthPolicy;
} = {}) {
	const owner = createStoreOwner();
	const broadcasts = new FakeBroadcastHub();
	const host = createBrowserWorkerHost({
		openStore: owner.openStore,
		hostId: 'browser-test-host',
		...(exchangeTimeoutMs === undefined ? {} : { exchangeTimeoutMs }),
		...(transportRetirementMs === undefined ? {} : { transportRetirementMs }),
		...(clientLivenessIntervalMs === undefined &&
		clientLivenessTimeoutMs === undefined
			? {}
			: {
					clientLivenessPolicy: {
						probeIntervalMs: clientLivenessIntervalMs ?? 60_000,
						responseTimeoutMs: clientLivenessTimeoutMs ?? 5 * 60_000,
					},
				}),
	});

	async function openControlledTab(): Promise<{
		epicenter: BrowserEpicenter;
		vanish(): void;
		pageMessages: unknown[];
		sendWorkerMessage(message: unknown): void;
		workerMessages: unknown[];
		blockPageMessageType(type: string): void;
		holdPageMessageType(type: string): void;
		releasePageMessageType(type: string): void;
		throwWorkerMessageType(type: string): void;
		isWorkerClosed(): boolean;
	}> {
		const {
			page,
			worker,
			vanish,
			pageMessages,
			sendWorkerMessage,
			workerMessages,
			blockPageMessageType,
			holdPageMessageType,
			releasePageMessageType,
			throwWorkerMessageType,
			isWorkerClosed,
		} = createPortPair();
		host.connect(worker);
		const epicenter = await openBrowserEpicenter({
			createSharedWorker: () => ({ port: page }),
			createBroadcastChannel: broadcasts.create,
			...(workerHealthPolicy === undefined ? {} : { workerHealthPolicy }),
		});
		return {
			epicenter,
			vanish,
			pageMessages,
			sendWorkerMessage,
			workerMessages,
			blockPageMessageType,
			holdPageMessageType,
			releasePageMessageType,
			throwWorkerMessageType,
			isWorkerClosed,
		};
	}

	async function openTab(): Promise<BrowserEpicenter> {
		return (await openControlledTab()).epicenter;
	}

	return { broadcasts, openControlledTab, openTab, owner };
}

function bindTestData(epicenter: BrowserEpicenter) {
	return epicenter.bind({ tables: { notes }, values: { theme } });
}

test('worker host refuses liveness values unsupported by browser timers', () => {
	expect(() =>
		createBrowserWorkerHost({
			clientLivenessPolicy: {
				probeIntervalMs: 2_147_483_648,
				responseTimeoutMs: 1,
			},
		}),
	).toThrow('supported timer values');
});

test('page proxy refuses health values unsupported by browser timers', async () => {
	await expect(
		openBrowserEpicenter({
			workerHealthPolicy: {
				probeIntervalMs: 2_147_483_648,
				responseTimeoutMs: 1,
			},
		}),
	).rejects.toThrow('supported timer values');
});

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

test('a throwing stale port cannot suppress invalidation for a healthy peer', async () => {
	const { openControlledTab, owner } = await setup({
		workerHealthPolicy: { probeIntervalMs: 10, responseTimeoutMs: 20 },
	});
	const stale = await openControlledTab();
	const healthy = await openControlledTab();
	const observed: string[][] = [];
	const unsubscribe = bindTestData(healthy.epicenter).tables.notes.subscribe(
		(ids) => observed.push(ids),
	);
	stale.throwWorkerMessageType('invalidation');

	const row = await bindTestData(healthy.epicenter).tables.notes.create({
		title: 'Healthy peer still notified',
	});
	await waitFor(() => observed.flat().includes(row.id));
	await expect(
		settleWithin(bindTestData(stale.epicenter).tables.notes.get(row.id), 1_000),
	).rejects.toThrow('stopped responding');
	expect(() => bindTestData(stale.epicenter)).toThrow('stopped responding');
	expect(owner.activeStores).toBe(1);
	unsubscribe();
	await healthy.epicenter[Symbol.asyncDispose]();
	await waitFor(() => owner.activeStores === 0);
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

test('stalled sync attachment does not block local RPC in either tab', async () => {
	const { openControlledTab, openTab } = await setup({
		exchangeTimeoutMs: 60_000,
	});
	const attaching = await openControlledTab();
	const peer = await openTab();
	let exchangeStarted = false;
	const attachment = attaching.epicenter
		.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange() {
				exchangeStarted = true;
				return new Promise<ExchangeResponse>(() => undefined);
			},
		})
		.then(
			() => undefined,
			(cause: unknown) => cause,
		);
	await waitFor(() => exchangeStarted);

	const [sameTabRow, peerRow] = await settleWithin(
		Promise.all([
			bindTestData(attaching.epicenter).tables.notes.create({
				title: 'Same tab remains local',
			}),
			bindTestData(peer).tables.notes.create({
				title: 'Peer remains local',
			}),
		]),
		1_000,
	);
	expect(sameTabRow.title).toBe('Same tab remains local');
	expect(peerRow.title).toBe('Peer remains local');

	const disposal = attaching.epicenter[Symbol.asyncDispose]();
	await expect(settleWithin(disposal, 1_000)).resolves.toBeUndefined();
	const attachmentFailure = await attachment;
	expect(attachmentFailure).toBeInstanceOf(Error);
	expect((attachmentFailure as Error).message).toContain('disposed');
	await peer[Symbol.asyncDispose]();
});

test('a newer attachment supersedes a stalled initial attachment promptly', async () => {
	const { openTab } = await setup({ exchangeTimeoutMs: 60_000 });
	const epicenter = await openTab();
	let stalledExchangeStarted = false;
	const stalled = epicenter.attachSync({
		deploymentId: 'https://example.test/',
		principalId: 'alice',
		exchange() {
			stalledExchangeStarted = true;
			return new Promise<ExchangeResponse>(() => undefined);
		},
	});
	await waitFor(() => stalledExchangeStarted);
	let replacementExchanges = 0;

	expectOk(
		await settleWithin(
			epicenter.attachSync({
				deploymentId: 'https://example.test/',
				principalId: 'alice',
				exchange(request) {
					replacementExchanges += 1;
					return acknowledge(request);
				},
			}),
			1_000,
		),
	);
	const stalledFailure = expectErr(await stalled);
	expect(stalledFailure.name).toBe('TransportFailed');
	const beforeWrite = replacementExchanges;
	await bindTestData(epicenter).tables.notes.create({
		title: 'Replacement is active',
	});
	await waitFor(() => replacementExchanges > beforeWrite);
	await epicenter[Symbol.asyncDispose]();
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

test('timed-out generations serialize page callbacks before a fresh retry', async () => {
	const { openTab } = await setup({ exchangeTimeoutMs: 10 });
	await using epicenter = await openTab();
	const requests: ExchangeRequest[] = [];
	let activeExchanges = 0;
	let maximumActiveExchanges = 0;
	let releaseStall: (() => void) | undefined;
	let stallNext = false;

	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			async exchange(request) {
				requests.push(request);
				activeExchanges += 1;
				maximumActiveExchanges = Math.max(
					maximumActiveExchanges,
					activeExchanges,
				);
				try {
					if (stallNext) {
						stallNext = false;
						await new Promise<void>((resolve) => {
							releaseStall = resolve;
						});
					}
					return acknowledge(request);
				} finally {
					activeExchanges -= 1;
				}
			},
		}),
	);
	const beforeWrite = requests.length;
	stallNext = true;

	await bindTestData(epicenter).tables.notes.create({
		title: 'Serialize retry',
	});
	await waitFor(() => releaseStall !== undefined);
	await Bun.sleep(30);
	expect(maximumActiveExchanges).toBe(1);
	expect(requests).toHaveLength(beforeWrite + 1);
	releaseStall?.();
	await waitFor(
		() =>
			requests.length >= beforeWrite + 2 &&
			epicenter.syncStatus.state === 'idle',
	);
	expect(requests.at(-1)).toEqual(requests.at(-2));
	expect(maximumActiveExchanges).toBe(1);
});

test('exchange cancellation requires both generation and transport key', async () => {
	const { openControlledTab } = await setup({ exchangeTimeoutMs: 1_000 });
	const tab = await openControlledTab();
	await using epicenter = tab.epicenter;
	let releaseExchange: (() => void) | undefined;
	let stallNext = false;

	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			async exchange(request) {
				if (stallNext) {
					stallNext = false;
					await new Promise<void>((resolve) => {
						releaseExchange = resolve;
					});
				}
				return acknowledge(request);
			},
		}),
	);
	stallNext = true;
	await bindTestData(epicenter).tables.notes.create({ title: 'Correlate' });
	await waitFor(() => releaseExchange !== undefined);
	const request = lastMessageOfType(tab.workerMessages, 'exchange-request');
	if (
		request === undefined ||
		typeof request.transportId !== 'number' ||
		typeof request.transportKey !== 'number'
	)
		throw new Error('Expected a correlated exchange request');
	tab.sendWorkerMessage({
		type: 'exchange-cancel',
		transportId: request.transportId + 1,
		transportKey: request.transportKey,
	});
	tab.sendWorkerMessage({
		type: 'exchange-cancel',
		transportId: request.transportId,
		transportKey: request.transportKey + 1,
	});
	releaseExchange?.();
	await waitFor(
		() =>
			lastMessageOfType(tab.pageMessages, 'exchange-result')?.transportId ===
			request.transportId,
	);
});

test('a timed-out sole transport keeps credentials until bounded retirement', async () => {
	const { openTab } = await setup({
		exchangeTimeoutMs: 10,
		transportRetirementMs: 50,
	});
	await using epicenter = await openTab();
	const states: string[] = [];
	const unsubscribe = epicenter.subscribeSyncStatus(({ state }) => {
		states.push(state);
	});
	let stallNext = false;

	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange(request) {
				if (stallNext) {
					stallNext = false;
					return new Promise<ExchangeResponse>(() => undefined);
				}
				return acknowledge(request);
			},
		}),
	);
	stallNext = true;

	await bindTestData(epicenter).tables.notes.create({ title: 'Retire stale' });
	await waitFor(() => epicenter.syncStatus.state === 'offline');
	expect(states).not.toContain('authentication-required');
	await waitFor(() => epicenter.syncStatus.state === 'authentication-required');
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
			async exchange(request) {
				firstExchanges += 1;
				if (firstStalls) {
					firstStalls = false;
					await Bun.sleep(25);
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

test('an abruptly vanished page is reclaimed with documents and pending sync', async () => {
	const { openControlledTab, openTab, owner } = await setup({
		exchangeTimeoutMs: 60_000,
		clientLivenessIntervalMs: 10,
		clientLivenessTimeoutMs: 20,
	});
	const tab = await openControlledTab();
	const survivor = await openTab();
	const notes = bindTestData(tab.epicenter).tables.notes;
	const row = await notes.create({ title: 'Vanishing page' });
	const document = await notes.openDocument(row.id);
	document.get('content').insert(0, 'owned by the vanished client');
	await document.whenDurable();
	let stallNext = false;
	let stalledExchangeStarted = false;
	expectOk(
		await tab.epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange(request) {
				if (stallNext) {
					stalledExchangeStarted = true;
					return new Promise<ExchangeResponse>(() => undefined);
				}
				return acknowledge(request);
			},
		}),
	);
	stallNext = true;
	await notes.create({ title: 'Starts a pending generation' });
	await waitFor(() => stalledExchangeStarted);
	const cancellationsBeforeVanish = countMessages(
		tab.workerMessages,
		'exchange-cancel',
	);

	tab.vanish();
	await waitFor(
		() => countMessages(tab.workerMessages, 'client-revoked') === 1,
	);
	expect(countMessages(tab.workerMessages, 'exchange-cancel')).toBeGreaterThan(
		cancellationsBeforeVanish,
	);
	expect(owner.activeStores).toBe(1);
	const survivorRow = await bindTestData(survivor).tables.notes.create({
		title: 'Surviving page remains local',
	});
	expect(survivorRow.title).toBe('Surviving page remains local');
	await survivor[Symbol.asyncDispose]();
	await waitFor(() => owner.activeStores === 0);
	expect(owner.disposeCount).toBe(1);

	await using replacement = await openTab();
	expect(replacement).toBeDefined();
	expect(owner.activeStores).toBe(1);
	expect(owner.openCount).toBe(2);
});

test('a nonresponsive connected page receives a terminal client failure', async () => {
	const { openControlledTab, owner } = await setup({
		clientLivenessIntervalMs: 10,
		clientLivenessTimeoutMs: 20,
	});
	const tab = await openControlledTab();
	tab.blockPageMessageType('liveness-probe');
	await waitFor(() => owner.activeStores === 0);
	expect(countMessages(tab.workerMessages, 'client-revoked')).toBe(1);
	await waitFor(() => {
		try {
			bindTestData(tab.epicenter);
			return false;
		} catch {
			return true;
		}
	});
	expect(() => bindTestData(tab.epicenter)).toThrow('stopped responding');
	await tab.epicenter[Symbol.asyncDispose]();
});

test('an acknowledgement after the deadline cannot revive a terminal client', async () => {
	const owner = createStoreOwner();
	const broadcasts = new FakeBroadcastHub();
	let releaseStore: (() => void) | undefined;
	const storeGate = new Promise<void>((resolve) => {
		releaseStore = resolve;
	});
	const host = createBrowserWorkerHost({
		async openStore(options) {
			await storeGate;
			return owner.openStore(options);
		},
		clientLivenessPolicy: { probeIntervalMs: 10, responseTimeoutMs: 20 },
	});
	const ports = createPortPair();
	ports.holdPageMessageType('liveness-probe');
	host.connect(ports.worker);
	const opening = openBrowserEpicenter({
		createSharedWorker: () => ({ port: ports.page }),
		createBroadcastChannel: broadcasts.create,
	}).then(
		() => undefined,
		(cause: unknown) => cause,
	);
	await waitFor(
		() => countMessages(ports.workerMessages, 'liveness-probe') === 1,
	);
	await Bun.sleep(25);
	ports.releasePageMessageType('liveness-probe');
	const failure = await settleWithin(opening, 1_000);
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toContain('stopped responding');
	releaseStore?.();
	await waitFor(() => owner.activeStores === 0);
	expect(countMessages(ports.workerMessages, 'client-revoked')).toBe(1);
});

test('terminal reclamation during store open cannot publish sync ownership', async () => {
	const owner = createStoreOwner();
	let releaseStore!: () => void;
	const storeGate = new Promise<void>((resolve) => {
		releaseStore = resolve;
	});
	const host = createBrowserWorkerHost({
		async openStore(options) {
			await storeGate;
			return owner.openStore(options);
		},
		clientLivenessPolicy: { probeIntervalMs: 10, responseTimeoutMs: 20 },
	});
	const ports = createPortPair();
	host.connect(ports.worker);
	ports.page.postMessage({
		type: 'request',
		id: 1,
		operation: {
			kind: 'attach-sync',
			transportKey: 1,
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			hasCredentials: true,
		},
	});

	await waitFor(
		() => countMessages(ports.workerMessages, 'client-revoked') === 1,
	);
	releaseStore();
	await waitFor(() => owner.activeStores === 0);
	expect(owner.attachmentAtDisposal).toBeUndefined();
	expect(countMessages(ports.workerMessages, 'exchange-request')).toBe(0);
	expect(countMessages(ports.workerMessages, 'result')).toBe(0);
});

test('worker health remains responsive during a legitimate slow local RPC', async () => {
	const owner = createStoreOwner();
	const broadcasts = new FakeBroadcastHub();
	let releaseStore!: () => void;
	const storeGate = new Promise<void>((resolve) => {
		releaseStore = resolve;
	});
	const host = createBrowserWorkerHost({
		async openStore(options) {
			await storeGate;
			return owner.openStore(options);
		},
	});
	const ports = createPortPair();
	host.connect(ports.worker);
	let settled = false;
	const opening = openBrowserEpicenter({
		createSharedWorker: () => ({ port: ports.page }),
		createBroadcastChannel: broadcasts.create,
		workerHealthPolicy: { probeIntervalMs: 10, responseTimeoutMs: 20 },
	}).finally(() => {
		settled = true;
	});

	await waitFor(
		() => countMessages(ports.workerMessages, 'worker-health-ack') > 0,
	);
	await Bun.sleep(50);
	expect(settled).toBe(false);
	releaseStore();
	const epicenter = await settleWithin(opening, 1_000);
	await epicenter[Symbol.asyncDispose]();
	await waitFor(() => owner.activeStores === 0);
});

test('liveness deadline fails closed while a local operation never settles', async () => {
	const host = createBrowserWorkerHost({
		openStore: () => new Promise<BrowserWorkerStore>(() => undefined),
		clientLivenessPolicy: { probeIntervalMs: 10, responseTimeoutMs: 20 },
	});
	const ports = createPortPair();
	ports.blockPageMessageType('liveness-probe');
	host.connect(ports.worker);
	const opening = openBrowserEpicenter({
		createSharedWorker: () => ({ port: ports.page }),
		createBroadcastChannel: () => undefined,
	}).then(
		() => undefined,
		(cause: unknown) => cause,
	);

	const failure = await settleWithin(opening, 1_000);
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toContain('stopped responding');
	expect(countMessages(ports.workerMessages, 'client-revoked')).toBe(1);
	await waitFor(() => ports.isWorkerClosed());
	const probesAtDeadline = countMessages(
		ports.workerMessages,
		'liveness-probe',
	);
	await Bun.sleep(40);
	expect(countMessages(ports.workerMessages, 'liveness-probe')).toBe(
		probesAtDeadline,
	);
});

test('storage theft terminally revokes clients and disposes their store', async () => {
	const { openControlledTab, owner } = await setup();
	const tab = await openControlledTab();
	const row = await bindTestData(tab.epicenter).tables.notes.create({
		title: 'Before theft',
	});
	await bindTestData(tab.epicenter).tables.notes.openDocument(row.id);

	owner.steal();
	await waitFor(() => owner.activeStores === 0);
	await waitFor(
		() => countMessages(tab.workerMessages, 'client-revoked') === 1,
	);
	await waitFor(() => {
		try {
			bindTestData(tab.epicenter);
			return false;
		} catch {
			return true;
		}
	});
	expect(() => bindTestData(tab.epicenter)).toThrow('storage moved');
	expect(owner.disposeCount).toBe(1);
	await tab.epicenter[Symbol.asyncDispose]();
	await expect(openControlledTab()).rejects.toThrow('storage moved');
	expect(owner.activeStores).toBe(0);
});

test('document-open cannot escape a concurrent terminal page failure', async () => {
	const { openControlledTab, owner } = await setup();
	const tab = await openControlledTab();
	const notes = bindTestData(tab.epicenter).tables.notes;
	const row = await notes.create({ title: 'Document race' });
	const resultsBeforeOpen = countMessages(tab.workerMessages, 'result');
	tab.holdPageMessageType('result');
	const opening = notes.openDocument(row.id);
	await waitFor(
		() => countMessages(tab.workerMessages, 'result') > resultsBeforeOpen,
	);

	tab.releasePageMessageType('result');
	owner.steal();
	const document = await opening;
	await waitFor(() => {
		try {
			document.get('content');
			return false;
		} catch {
			return true;
		}
	});
	expect(() => document.get('content')).toThrow('storage moved');
	await waitFor(() => owner.activeStores === 0);
	await document[Symbol.asyncDispose]();
	await tab.epicenter[Symbol.asyncDispose]();
});

test('a document opened after terminal reclamation is disposed before publication', async () => {
	let releaseDocument!: () => void;
	const documentGate = new Promise<void>((resolve) => {
		releaseDocument = resolve;
	});
	let documentOpened!: () => void;
	const documentWasOpened = new Promise<void>((resolve) => {
		documentOpened = resolve;
	});
	let delayedDocumentDisposals = 0;
	const owner = createStoreOwner({
		async transformDocument(document) {
			documentOpened();
			await documentGate;
			return Object.create(document, {
				[Symbol.asyncDispose]: {
					async value() {
						delayedDocumentDisposals += 1;
						await document[Symbol.asyncDispose]();
					},
				},
			}) as RowDocument;
		},
	});
	const broadcasts = new FakeBroadcastHub();
	const host = createBrowserWorkerHost({ openStore: owner.openStore });
	const ports = createPortPair();
	host.connect(ports.worker);
	const epicenter = await openBrowserEpicenter({
		createSharedWorker: () => ({ port: ports.page }),
		createBroadcastChannel: broadcasts.create,
	});
	const notes = bindTestData(epicenter).tables.notes;
	const row = await notes.create({ title: 'Delayed document ownership' });
	const opening = notes.openDocument(row.id).then(
		() => undefined,
		(cause: unknown) => cause,
	);
	await documentWasOpened;

	owner.steal();
	const failure = await settleWithin(opening, 1_000);
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toContain('storage moved');
	releaseDocument();
	await waitFor(() => owner.activeStores === 0);
	expect(delayedDocumentDisposals).toBe(1);
	expect(countMessages(ports.workerMessages, 'result')).toBe(2);
	await epicenter[Symbol.asyncDispose]();
});

test('an idle live page answers probes and explicit disposal stops probing', async () => {
	const { openControlledTab, owner } = await setup({
		clientLivenessIntervalMs: 10,
		clientLivenessTimeoutMs: 20,
	});
	const tab = await openControlledTab();
	await Bun.sleep(50);
	expect(countMessages(tab.workerMessages, 'liveness-probe')).toBeGreaterThan(
		0,
	);
	expect(owner.activeStores).toBe(1);

	await tab.epicenter[Symbol.asyncDispose]();
	const probesAtDisposal = countMessages(tab.workerMessages, 'liveness-probe');
	await Bun.sleep(40);
	expect(countMessages(tab.workerMessages, 'liveness-probe')).toBe(
		probesAtDisposal,
	);
	expect(owner.activeStores).toBe(0);
});

test('retired transports can reattach repeatedly without reviving old callbacks', async () => {
	const { openControlledTab } = await setup({
		exchangeTimeoutMs: 10,
		transportRetirementMs: 30,
	});
	const tab = await openControlledTab();
	await using epicenter = tab.epicenter;
	const attachments = [
		{ count: 0, stallNext: false },
		{ count: 0, stallNext: false },
		{ count: 0, stallNext: false },
	];

	async function attach(index: number): Promise<void> {
		const attachment = attachments[index];
		if (attachment === undefined) throw new Error('Missing test attachment');
		expectOk(
			await epicenter.attachSync({
				deploymentId: 'https://example.test/',
				principalId: 'alice',
				exchange(request) {
					attachment.count += 1;
					if (attachment.stallNext) {
						attachment.stallNext = false;
						return new Promise<ExchangeResponse>(() => undefined);
					}
					return acknowledge(request);
				},
			}),
		);
	}

	for (let index = 0; index < 2; index += 1) {
		await attach(index);
		const attachment = attachments[index];
		if (attachment === undefined) throw new Error('Missing test attachment');
		attachment.stallNext = true;
		const retirementsBeforeWrite = countMessages(
			tab.workerMessages,
			'exchange-retire',
		);
		await bindTestData(epicenter).tables.notes.create({
			title: `Retire ${index}`,
		});
		await waitFor(
			() =>
				countMessages(tab.workerMessages, 'exchange-retire') >
				retirementsBeforeWrite,
		);
		await waitFor(
			() => epicenter.syncStatus.state === 'authentication-required',
		);
	}

	const retiredCounts = attachments.slice(0, 2).map(({ count }) => count);
	await attach(2);
	const healthy = attachments[2];
	if (healthy === undefined) throw new Error('Missing healthy attachment');
	const healthyBeforeWrite = healthy.count;
	await bindTestData(epicenter).tables.notes.create({ title: 'Healthy again' });
	await waitFor(() => healthy.count > healthyBeforeWrite);
	expect(attachments.slice(0, 2).map(({ count }) => count)).toEqual(
		retiredCounts,
	);
});

test('replacing an in-flight transport terminally retires its callback capability', async () => {
	const { openControlledTab } = await setup({
		exchangeTimeoutMs: 60_000,
		transportRetirementMs: 60_000,
	});
	const tab = await openControlledTab();
	await using epicenter = tab.epicenter;
	let firstExchanges = 0;
	let secondExchanges = 0;
	let stallFirst = false;

	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange(request) {
				firstExchanges += 1;
				if (stallFirst) return new Promise<ExchangeResponse>(() => undefined);
				return acknowledge(request);
			},
		}),
	);
	stallFirst = true;
	await bindTestData(epicenter).tables.notes.create({ title: 'Stall old' });
	await waitFor(() => firstExchanges >= 2);
	const retirementsBeforeReplacement = countMessages(
		tab.workerMessages,
		'exchange-retire',
	);

	expectOk(
		await settleWithin(
			epicenter.attachSync({
				deploymentId: 'https://example.test/',
				principalId: 'alice',
				exchange(request) {
					secondExchanges += 1;
					return acknowledge(request);
				},
			}),
			1_000,
		),
	);
	expect(countMessages(tab.workerMessages, 'exchange-retire')).toBe(
		retirementsBeforeReplacement + 1,
	);
	const firstAfterReplacement = firstExchanges;
	const secondBeforeWrite = secondExchanges;
	await bindTestData(epicenter).tables.notes.create({
		title: 'Use replacement',
	});
	await waitFor(() => secondExchanges > secondBeforeWrite);
	expect(firstExchanges).toBe(firstAfterReplacement);
});

test('disposing during replacement fails the new exchange without its timeout', async () => {
	const { openControlledTab } = await setup({
		exchangeTimeoutMs: 60_000,
		transportRetirementMs: 60_000,
	});
	const tab = await openControlledTab();
	let firstExchanges = 0;
	let secondExchanges = 0;
	let stallFirst = false;

	expectOk(
		await tab.epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange(request) {
				firstExchanges += 1;
				if (stallFirst) return new Promise<ExchangeResponse>(() => undefined);
				return acknowledge(request);
			},
		}),
	);
	stallFirst = true;
	await bindTestData(tab.epicenter).tables.notes.create({ title: 'Stall old' });
	await waitFor(() => firstExchanges >= 2);
	const replacing = tab.epicenter.attachSync({
		deploymentId: 'https://example.test/',
		principalId: 'alice',
		exchange(request) {
			secondExchanges += 1;
			return acknowledge(request);
		},
	});
	const disposing = tab.epicenter[Symbol.asyncDispose]();
	const [replacement, disposal] = await settleWithin(
		Promise.allSettled([replacing, disposing]),
		1_000,
	);
	expect(replacement.status).toBe('rejected');
	expect(disposal.status).toBe('fulfilled');
	expect(secondExchanges).toBe(0);
});

test('disposing a page cancels its active exchange generation', async () => {
	const { openControlledTab } = await setup({ exchangeTimeoutMs: 100 });
	const tab = await openControlledTab();
	let releaseExchange: (() => void) | undefined;
	let stallNext = false;
	let exchanges = 0;

	expectOk(
		await tab.epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			async exchange(request) {
				exchanges += 1;
				if (stallNext) {
					stallNext = false;
					await new Promise<void>((resolve) => {
						releaseExchange = resolve;
					});
				}
				return acknowledge(request);
			},
		}),
	);
	stallNext = true;
	await bindTestData(tab.epicenter).tables.notes.create({ title: 'Dispose' });
	await waitFor(() => releaseExchange !== undefined);
	const activeRequest = lastMessageOfType(
		tab.workerMessages,
		'exchange-request',
	);
	const exchangesAtDisposal = exchanges;
	const disposal = tab.epicenter[Symbol.asyncDispose]();
	expect(() =>
		bindTestData(tab.epicenter).tables.notes.create({ title: 'Too late' }),
	).toThrow('disposed');
	if (
		activeRequest === undefined ||
		typeof activeRequest.transportKey !== 'number' ||
		typeof activeRequest.request !== 'object'
	)
		throw new Error('Expected an active exchange request');
	tab.sendWorkerMessage({
		type: 'exchange-request',
		transportId: Number.MAX_SAFE_INTEGER,
		transportKey: activeRequest.transportKey,
		request: activeRequest.request,
	});
	await Promise.resolve();
	expect(exchanges).toBe(exchangesAtDisposal);
	await disposal;
	const resultsAtDisposal = countMessages(tab.pageMessages, 'exchange-result');
	releaseExchange?.();
	await Bun.sleep(10);
	expect(countMessages(tab.pageMessages, 'exchange-result')).toBe(
		resultsAtDisposal,
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

async function settleWithin<TValue>(
	promise: Promise<TValue>,
	timeoutMs: number,
): Promise<TValue> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Operation exceeded ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
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

function countMessages(messages: unknown[], type: string): number {
	return messages.filter(
		(message) =>
			typeof message === 'object' &&
			message !== null &&
			'type' in message &&
			message.type === type,
	).length;
}

function lastMessageOfType(
	messages: unknown[],
	type: string,
): (Record<string, unknown> & { type: string }) | undefined {
	return messages.findLast(
		(message): message is Record<string, unknown> & { type: string } =>
			typeof message === 'object' &&
			message !== null &&
			'type' in message &&
			message.type === type,
	);
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
