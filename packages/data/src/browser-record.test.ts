/**
 * Browser Universal-Record Adapter Tests
 *
 * Drives page clients through two dedicated-worker candidates and an in-memory
 * BroadcastChannel/Web-Lock model over the real universal-record SQLite store.
 *
 * Key behaviors:
 * - every request, response, event, and coordination message is cloneable
 * - two tabs route through one elected owner and receive invalidations
 * - page-local Yjs handles persist, converge, and revoke by record address
 * - closing a follower does not dispose the elected owner
 * - owner loss fails an ambiguous mutation without replaying it
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { createLogger, type Logger, memorySink } from 'wellcrafted/logger';

import type {
	BlobFileStore,
	OwnedBlobFile,
	StagedBlob,
} from './blob-v1/index.js';
import type {
	BrowserRecordCoordinationMessage,
	BrowserRecordOperation,
	BrowserRecordResult,
	BrowserRecordWorkerInbound,
	BrowserRecordWorkerMessage,
} from './browser-record/protocol.js';
import {
	type BrowserRecordCandidateWorkerScope,
	type BrowserRecordCoordinationChannel,
	type OpenBrowserRecordWorkerOwner,
	startBrowserRecordCandidateWorker,
} from './browser-record/worker.js';
import {
	type BrowserRecordClientWorker,
	openBrowserRecordEpicenterForTest,
} from './browser-record.js';
import { defineLens, defineTable, defineValues } from './lens.js';
import { sha256HexBytes } from './protocol/v1/canonical.js';
import type { RecordAddress } from './protocol/v1/index.js';
import { makeLimits } from './protocol/v1/kernel.test-support.js';
import { recordDocumentConnectionTarget } from './record-document-connection.js';
import { createRecordOwner } from './record-epicenter.js';
import {
	createReplicaBlobStore,
	openReplicaStore,
	type ReplicaStore,
} from './store/replica/index.js';

class MemoryBlobFiles implements BlobFileStore<Blob, Blob> {
	readonly staged = new Map<string, Blob>();
	readonly owned = new Map<string, Blob>();
	#nextStage = 0;

	async stage(source: Blob): Promise<StagedBlob> {
		const bytes = new Uint8Array(await source.arrayBuffer());
		const digest = sha256HexBytes(bytes);
		const id = `stage-${++this.#nextStage}`;
		this.staged.set(id, new Blob([bytes]));
		return { id, digest };
	}

	async promote(staged: StagedBlob, owner: OwnedBlobFile): Promise<void> {
		const bytes = this.staged.get(staged.id);
		if (bytes === undefined) throw new Error('staged bytes are missing');
		this.owned.set(this.key(owner), bytes);
		this.staged.delete(staged.id);
	}

	async open(owner: OwnedBlobFile): Promise<Blob> {
		const bytes = this.owned.get(this.key(owner));
		if (bytes === undefined) throw new Error('owned bytes are missing');
		return new Blob([await bytes.arrayBuffer()]);
	}

	async sweepStaging(): Promise<void> {
		this.staged.clear();
	}

	async sweepContent(owned: readonly OwnedBlobFile[]): Promise<void> {
		const retained = new Set(owned.map((owner) => this.key(owner)));
		for (const key of this.owned.keys()) {
			if (!retained.has(key)) this.owned.delete(key);
		}
	}

	private key(owner: OwnedBlobFile): string {
		return `${owner.ownerKey}/${owner.digest}`;
	}
}

class FakeBroadcastHub {
	private readonly channels = new Map<string, Set<FakeBroadcastChannel>>();
	readonly messages: BrowserRecordCoordinationMessage[] = [];
	onPost?: (message: BrowserRecordCoordinationMessage) => void;

	create = (name: string): BrowserRecordCoordinationChannel => {
		const channel = new FakeBroadcastChannel(this, name);
		const peers = this.channels.get(name) ?? new Set();
		peers.add(channel);
		this.channels.set(name, peers);
		return channel;
	};

	post(
		source: FakeBroadcastChannel,
		name: string,
		message: BrowserRecordCoordinationMessage,
	): void {
		this.messages.push(structuredClone(message));
		this.onPost?.(message);
		for (const channel of this.channels.get(name) ?? []) {
			if (channel === source) continue;
			const cloned = structuredClone(message);
			setTimeout(() => channel.onmessage?.({ data: cloned }), 0);
		}
	}

	remove(name: string, channel: FakeBroadcastChannel): void {
		const peers = this.channels.get(name);
		peers?.delete(channel);
		if (peers?.size === 0) this.channels.delete(name);
	}
}

class FakeBroadcastChannel implements BrowserRecordCoordinationChannel {
	onmessage:
		| ((event: { data: BrowserRecordCoordinationMessage }) => void)
		| null = null;

	constructor(
		private readonly hub: FakeBroadcastHub,
		private readonly name: string,
	) {}

	postMessage(message: BrowserRecordCoordinationMessage): void {
		this.hub.post(this, this.name, message);
	}

	close(): void {
		this.hub.remove(this.name, this);
	}
}

class FakeCandidateWorker implements BrowserRecordClientWorker {
	private readonly pageMessageListeners = new Set<
		(event: { data: BrowserRecordWorkerMessage }) => void
	>();
	private readonly pageErrorListeners = new Set<
		(event: { message?: string }) => void
	>();
	private readonly workerMessageListeners = new Set<
		(event: { data: BrowserRecordWorkerInbound }) => void
	>();
	readonly messages: BrowserRecordWorkerMessage[] = [];
	readonly inbound: BrowserRecordWorkerInbound[] = [];
	private isTerminated = false;
	private isScopeClosed = false;

	constructor(
		options: Parameters<typeof startBrowserRecordCandidateWorker>[1],
	) {
		const scope: BrowserRecordCandidateWorkerScope = {
			postMessage: (message) => {
				const cloned = structuredClone(message);
				this.messages.push(cloned);
				setTimeout(() => {
					if (this.isTerminated) return;
					for (const listener of this.pageMessageListeners) {
						listener({ data: cloned });
					}
				}, 0);
			},
			addEventListener: (_type, listener) => {
				this.workerMessageListeners.add(listener);
			},
			close: () => {
				this.isScopeClosed = true;
			},
		};
		startBrowserRecordCandidateWorker(scope, options);
	}

	postMessage(message: BrowserRecordWorkerInbound): void {
		if (this.isTerminated) throw new Error('worker is terminated');
		const cloned = structuredClone(message);
		this.inbound.push(cloned);
		setTimeout(() => {
			for (const listener of this.workerMessageListeners) {
				listener({ data: cloned });
			}
		}, 0);
	}

	addEventListener(
		type: 'message' | 'error',
		listener:
			| ((event: { data: BrowserRecordWorkerMessage }) => void)
			| ((event: { message?: string }) => void),
	): void {
		if (type === 'message') {
			this.pageMessageListeners.add(
				listener as (event: { data: BrowserRecordWorkerMessage }) => void,
			);
		} else {
			this.pageErrorListeners.add(
				listener as (event: { message?: string }) => void,
			);
		}
	}

	terminate(): void {
		this.isTerminated = true;
		this.pageMessageListeners.clear();
		this.pageErrorListeners.clear();
	}

	fail(message = 'dedicated worker failed'): void {
		for (const listener of this.pageErrorListeners) listener({ message });
	}

	get terminated(): boolean {
		return this.isTerminated;
	}

	get scopeClosed(): boolean {
		return this.isScopeClosed;
	}
}

const notesLens = defineLens({
	namespace: 'so.epicenter.browser-record',
	title: 'Browser Records',
	description: 'Browser record adapter evidence.',
	collections: {
		notes: defineTable({
			title: 'Notes',
			fields: { title: field.string() },
			optional: [],
		}),
		settings: defineValues({
			title: 'Settings',
			values: { theme: field.select(['light', 'dark']) },
		}),
	},
});

const reversibleValuesLens = defineLens({
	namespace: notesLens.namespace,
	title: 'Reversible values',
	description: 'Exercises document retention across reversible absence.',
	collections: {
		preserved: defineValues({
			title: 'Preserved',
			values: { aaaaaaaaaaaaaaaaaaaaaaaa: field.string() },
		}),
	},
});

const reversibleTableLens = defineLens({
	namespace: notesLens.namespace,
	title: 'Reversible table interpretation',
	description: 'Opens the same record through an overlapping table Lens.',
	collections: {
		preserved: defineTable({
			title: 'Preserved',
			fields: { title: field.string() },
			optional: [],
		}),
	},
});

const ADDRESS: RecordAddress = {
	namespace: notesLens.namespace,
	collection: 'notes',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};

function setup({
	afterLocalWrite,
	afterOwnerAcquired,
	beforeOwnerDispose,
	integrityCheck,
	failFirstOpen = false,
	cleanupFailures = false,
}: {
	afterLocalWrite?(): void;
	afterOwnerAcquired?(openCount: number): void | Promise<void>;
	beforeOwnerDispose?(disposeCount: number): void | Promise<void>;
	integrityCheck?(openCount: number): void | Promise<void>;
	failFirstOpen?: boolean;
	cleanupFailures?: boolean;
} = {}) {
	const database = new Database(':memory:', { strict: true });
	const adapter = createBunSqliteAdapter(database);
	const files = new MemoryBlobFiles();
	const broadcasts = new FakeBroadcastHub();
	const waiters: {
		options: Parameters<OpenBrowserRecordWorkerOwner>[0];
		resolve: (owner: Awaited<ReturnType<OpenBrowserRecordWorkerOwner>>) => void;
		reject: (cause: unknown) => void;
	}[] = [];
	let isOwnerActive = false;
	let activeOnStolen: (() => void) | undefined;
	let openCount = 0;
	let disposeCount = 0;
	let localWriteCount = 0;
	let candidateCount = 0;
	let ownerGeneration = 0;
	let didFailFirstOpen = false;
	const workers: FakeCandidateWorker[] = [];
	const cleanupCounts = {
		records: 0,
		blobs: 0,
		status: 0,
		owner: 0,
		channel: 0,
	};

	function createChannel(name: string): BrowserRecordCoordinationChannel {
		const channel = broadcasts.create(name);
		if (!cleanupFailures) return channel;
		return {
			get onmessage() {
				return channel.onmessage;
			},
			set onmessage(listener) {
				channel.onmessage = listener;
			},
			postMessage(message) {
				channel.postMessage(message);
			},
			close() {
				channel.close();
				cleanupCounts.channel += 1;
				throw new Error('coordination channel cleanup failed');
			},
		};
	}

	function grant(
		options: Parameters<OpenBrowserRecordWorkerOwner>[0],
	): Awaited<ReturnType<OpenBrowserRecordWorkerOwner>> {
		isOwnerActive = true;
		activeOnStolen = options.onStolen;
		openCount += 1;
		ownerGeneration += 1;
		const storedReplica = openReplicaStore({
			database: adapter,
			limits: makeLimits(),
			initialize: { replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr' },
		});
		const replica: ReplicaStore = {
			...storedReplica,
			localWrite(intent) {
				storedReplica.localWrite(intent);
				localWriteCount += 1;
				afterLocalWrite?.();
			},
			subscribe(listener) {
				const stop = storedReplica.subscribe(listener);
				return () => {
					const stopped = stop();
					cleanupCounts.records += 1;
					if (cleanupFailures)
						throw new Error('record listener cleanup failed');
					return stopped;
				};
			},
		};
		const storedBlobs = createReplicaBlobStore(adapter, files);
		const blobs = {
			...storedBlobs,
			subscribe(listener: Parameters<typeof storedBlobs.subscribe>[0]) {
				const stop = storedBlobs.subscribe(listener);
				return () => {
					const stopped = stop();
					cleanupCounts.blobs += 1;
					if (cleanupFailures) throw new Error('blob listener cleanup failed');
					return stopped;
				};
			},
		};
		const storedOwner = createRecordOwner({
			replica: storedReplica,
			blobs: storedBlobs,
			async dispose() {
				if (!isOwnerActive) return;
				await beforeOwnerDispose?.(disposeCount + 1);
				isOwnerActive = false;
				activeOnStolen = undefined;
				disposeCount += 1;
				cleanupCounts.owner += 1;
				const next = waiters.shift();
				if (next !== undefined) void resolveGrant(next);
				if (cleanupFailures) throw new Error('owner cleanup failed');
			},
		});
		const owner = {
			...storedOwner,
			subscribeSyncStatus(
				listener: Parameters<typeof storedOwner.subscribeSyncStatus>[0],
			) {
				const stop = storedOwner.subscribeSyncStatus(listener);
				return () => {
					stop();
					cleanupCounts.status += 1;
					if (cleanupFailures)
						throw new Error('status listener cleanup failed');
				};
			},
		};
		return {
			owner,
			replica,
			blobs,
			ownerGeneration,
			integrityCheck: () => integrityCheck?.(openCount),
		};
	}

	async function resolveGrant(waiter: (typeof waiters)[number]): Promise<void> {
		try {
			const opened = grant(waiter.options);
			await afterOwnerAcquired?.(openCount);
			waiter.resolve(opened);
		} catch (cause) {
			waiter.reject(cause);
		}
	}

	const openOwner: OpenBrowserRecordWorkerOwner = async (options) => {
		if (failFirstOpen && !didFailFirstOpen) {
			didFailFirstOpen = true;
			throw new Error('initial owner open failed');
		}
		if (!isOwnerActive) {
			const opened = grant(options);
			await afterOwnerAcquired?.(openCount);
			return opened;
		}
		return new Promise((resolve, reject) => {
			const waiter = { options, resolve, reject };
			waiters.push(waiter);
			options.signal.addEventListener(
				'abort',
				() => {
					const index = waiters.indexOf(waiter);
					if (index !== -1) waiters.splice(index, 1);
					reject(options.signal.reason);
				},
				{ once: true },
			);
		});
	};

	function createWorker() {
		candidateCount += 1;
		const worker = new FakeCandidateWorker({
			openOwner,
			createChannel,
			candidateId: `candidate-${candidateCount}`,
			mintOwnerSession: () => `owner-${candidateCount}-${openCount + 1}`,
		});
		workers.push(worker);
		return worker;
	}

	async function openTab(log?: Logger) {
		const worker = createWorker();
		return openBrowserRecordEpicenterForTest({
			createWorker: () => worker,
			coordinationId: 'browser-record-test',
			...(log === undefined ? {} : { log }),
		});
	}

	return {
		openTab,
		createWorker,
		openOwner,
		broadcasts,
		workers,
		cleanupCounts,
		steal() {
			if (activeOnStolen === undefined) throw new Error('owner is not open');
			activeOnStolen();
		},
		async dispose() {
			await waitFor(() => !isOwnerActive && waiters.length === 0);
			database.close();
		},
		get activeOwners() {
			return Number(isOwnerActive);
		},
		get disposeCount() {
			return disposeCount;
		},
		get localWriteCount() {
			return localWriteCount;
		},
		get openCount() {
			return openCount;
		},
		get waiterCount() {
			return waiters.length;
		},
	};
}

function bindNotes(
	epicenter: Awaited<ReturnType<typeof openBrowserRecordEpicenterForTest>>,
) {
	return epicenter.bind({ browser: notesLens }).browser;
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempts = 0; attempts < 200; attempts += 1) {
		if (condition()) return;
		await Bun.sleep(5);
	}
	throw new Error('condition was not met');
}

function deferred() {
	let resolve!: () => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<void>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

test('all record browser protocol variants survive structured clone', () => {
	const operations: BrowserRecordOperation[] = [
		{ kind: 'open' },
		{ kind: 'read', address: ADDRESS },
		{
			kind: 'read-page',
			namespace: ADDRESS.namespace,
			collection: ADDRESS.collection,
			after: ADDRESS.recordKey,
			limit: 25,
		},
		{
			kind: 'create-record',
			namespace: ADDRESS.namespace,
			collection: ADDRESS.collection,
			payload: { title: 'clone' },
		},
		{
			kind: 'patch-live',
			address: ADDRESS,
			patch: { set: { title: 'patched' }, unset: ['old'] },
		},
		{ kind: 'tombstone-live', address: ADDRESS },
		{ kind: 'replace', address: ADDRESS, value: { title: 'replace' } },
		{ kind: 'unset', address: ADDRESS },
		{ kind: 'export-document', address: ADDRESS },
		{
			kind: 'append-local-document-update',
			address: ADDRESS,
			update: new Uint8Array([1]),
		},
		{
			kind: 'install-accepted-document-update',
			address: ADDRESS,
			update: new Uint8Array([2]),
		},
		{ kind: 'put-blob', address: ADDRESS, bytes: new Blob(['blob']) },
		{ kind: 'read-blob', address: ADDRESS },
		{ kind: 'inspect-blob', address: ADDRESS },
		{ kind: 'attachment' },
		{
			kind: 'prepare-attachment',
			attachment: { deploymentId: 'cloud', principalId: 'person' },
			firstAttachmentChoice: 'bring',
		},
		{ kind: 'sync-status' },
		{ kind: 'parked-work', after: ADDRESS },
		{ kind: 'inspect-record', address: ADDRESS },
	];
	const status = {
		state: 'offline' as const,
		work: {
			scalar: { pending: 1, sealed: 0, parked: 0 },
			document: { pending: 0, parked: 0 },
			blob: { pending: 0, parked: 0 },
		},
		lastError: 'offline',
	};
	const results: BrowserRecordResult[] = [
		{ kind: 'open' },
		{ kind: 'read', record: null },
		{ kind: 'read-page', page: { entries: [], nextAfter: 'next' } },
		{ kind: 'create-record', recordKey: ADDRESS.recordKey },
		{ kind: 'patch-live', record: null },
		{ kind: 'tombstone-live', deleted: true },
		{ kind: 'replace' },
		{ kind: 'unset' },
		{
			kind: 'export-document',
			recordState: 'live',
			update: new Uint8Array([1]),
		},
		{ kind: 'append-local-document-update' },
		{ kind: 'install-accepted-document-update' },
		{ kind: 'put-blob', digest: 'a'.repeat(64) },
		{ kind: 'read-blob', bytes: new Blob(['blob']) },
		{ kind: 'inspect-blob', inspection: { kind: 'absent' } },
		{
			kind: 'attachment',
			attachment: { kind: 'unattached', requiresChoice: false },
		},
		{ kind: 'prepare-attachment', attached: true, discarded: false },
		{ kind: 'sync-status', status },
		{ kind: 'parked-work', page: { entries: [] } },
		{
			kind: 'inspect-record',
			inspection: {
				lanes: null,
				document: null,
				blob: { kind: 'absent' },
			},
		},
	];
	const messages: BrowserRecordWorkerMessage[] = [
		...results.map((result, id) => ({ type: 'result' as const, id, result })),
		{ type: 'error', id: 1, name: 'Error', message: 'failure' },
		{
			type: 'records-invalidated',
			token: 'owner:1',
			addresses: [ADDRESS],
		},
		{ type: 'blob-invalidated', token: 'owner:2', address: ADDRESS },
		{
			type: 'address-revoked',
			token: 'owner:3',
			address: ADDRESS,
			message: 'revoked',
		},
		{ type: 'sync-status', token: 'owner:4', status },
		{ type: 'owner-lost', name: 'OwnerLost', message: 'lost' },
		{
			type: 'status',
			role: 'owner',
			ownerSession: 'owner',
			ownerGeneration: 1,
		},
		{ type: 'closed' },
		{ type: 'fatal', name: 'Error', message: 'fatal' },
	];
	const sampleOperation: BrowserRecordOperation = { kind: 'open' };
	const sampleResult: BrowserRecordResult = { kind: 'open' };
	const request = {
		type: 'request' as const,
		id: 1,
		operation: sampleOperation,
	};
	const coordination: BrowserRecordCoordinationMessage[] = [
		{ version: 1, type: 'discover', candidateId: 'candidate' },
		{
			version: 1,
			type: 'owner',
			candidateId: 'candidate',
			ownerSession: 'owner',
			ownerGeneration: 1,
		},
		{
			version: 1,
			type: 'request',
			candidateId: 'candidate',
			ownerSession: 'owner',
			ownerGeneration: 1,
			request,
		},
		{
			version: 1,
			type: 'response',
			candidateId: 'candidate',
			ownerSession: 'owner',
			ownerGeneration: 1,
			message: { type: 'result', id: 1, result: sampleResult },
		},
		{
			version: 1,
			type: 'event',
			ownerSession: 'owner',
			ownerGeneration: 1,
			message: messages[2] as Extract<
				BrowserRecordWorkerMessage,
				{ type: 'records-invalidated' }
			>,
		},
	];
	const inbound: BrowserRecordWorkerInbound[] = [
		{ type: 'start', coordinationId: 'clone' },
		request,
		{ type: 'close' },
	];

	for (const value of [
		...operations.map((operation, id) => ({
			type: 'request' as const,
			id,
			operation,
		})),
		...inbound,
		...messages,
		...coordination,
	]) {
		expect(() => structuredClone(value)).not.toThrow();
	}
});

test('two tabs share one elected owner and receive record and blob invalidations', async () => {
	const context = setup();
	const first = await context.openTab();
	const second = await context.openTab();
	try {
		const firstData = bindNotes(first);
		const secondData = bindNotes(second);
		const changed: string[][] = [];
		secondData.notes.subscribe((ids) => changed.push(ids));

		const row = await firstData.notes.create({ title: 'shared' });
		await waitFor(() => changed.flat().includes(row.id));
		expect(await secondData.notes.get(row.id)).toMatchObject({
			data: { id: row.id, title: 'shared' },
		});
		const digest = await firstData.notes.blob.put(
			row.id,
			new Blob(['shared bytes']),
		);
		await waitFor(
			() =>
				changed.flat().filter((recordId) => recordId === row.id).length >= 2,
		);
		expect(await (await secondData.notes.blob.get(row.id))?.text()).toBe(
			'shared bytes',
		);
		expect(await secondData.notes.blob.inspect(row.id)).toEqual({
			kind: 'pending',
			digest,
		});
		expect(await second.attachment()).toEqual({
			kind: 'unattached',
			requiresChoice: true,
		});
		expect((await second.syncStatus()).state).toBe('local');
		expect((await second.parkedWork()).entries).toEqual([]);
		expect(context.openCount).toBe(1);
	} finally {
		await second[Symbol.asyncDispose]();
		await first[Symbol.asyncDispose]();
		await context.dispose();
	}
});

test('page-local documents persist across tabs and revoke on tombstone', async () => {
	const context = setup();
	const first = await context.openTab();
	const second = await context.openTab();
	try {
		const firstNotes = bindNotes(first).notes;
		const secondNotes = bindNotes(second).notes;
		const row = await firstNotes.create({ title: 'document' });
		const firstDocument = await firstNotes.openDocument(row.id);
		firstDocument.get('content').insert(0, 'local');
		await firstDocument.whenDurable();
		const secondDocument = await secondNotes.openDocument(row.id);
		expect(secondDocument.get('content').toString()).toBe('local');
		secondDocument.get('content').insert(5, ' shared');
		await secondDocument.whenDurable();
		await waitFor(
			() => firstDocument.get('content').toString() === 'local shared',
		);

		await firstNotes.delete(row.id);
		await waitFor(() => {
			try {
				firstDocument.get('content');
				return false;
			} catch {
				try {
					secondDocument.get('content');
					return false;
				} catch {
					return true;
				}
			}
		});
		expect(() => secondDocument.get('content')).toThrow(/no longer live/);
		await firstDocument[Symbol.asyncDispose]();
		await secondDocument[Symbol.asyncDispose]();
	} finally {
		await second[Symbol.asyncDispose]();
		await first[Symbol.asyncDispose]();
		await context.dispose();
	}
});

test('accepted document updates are durable before whenDurable resolves', async () => {
	const context = setup();
	const tab = await context.openTab();
	try {
		const notes = bindNotes(tab).notes;
		const row = await notes.create({ title: 'accepted' });
		const document = await notes.openDocument(row.id);
		const remote = new Y.Doc();
		remote.get('content').insert(0, 'authority');
		recordDocumentConnectionTarget(document).applyUpdate(
			new Uint8Array(Y.encodeStateAsUpdateV2(remote)),
			Symbol('authority'),
		);
		await document.whenDurable();

		expect(document.get('content').toString()).toBe('authority');
		expect(
			await tab.inspectRecord({
				namespace: notesLens.namespace,
				collection: 'notes',
				recordKey: row.id,
			}),
		).toMatchObject({ document: { dirty: false } });
		remote.destroy();
		await document[Symbol.asyncDispose]();
	} finally {
		await tab[Symbol.asyncDispose]();
		await context.dispose();
	}
});

test('reversible unset preserves an open document handle', async () => {
	const context = setup();
	const tab = await context.openTab();
	try {
		const values = tab.bind({ values: reversibleValuesLens }).values.preserved;
		const table = tab.bind({ table: reversibleTableLens }).table.preserved;
		await values.aaaaaaaaaaaaaaaaaaaaaaaa.set('live');
		const document = await table.openDocument('aaaaaaaaaaaaaaaaaaaaaaaa');
		const peerDocument = await table.openDocument('aaaaaaaaaaaaaaaaaaaaaaaa');
		document.get('content').insert(0, 'preserved');
		await document.whenDurable();
		await values.aaaaaaaaaaaaaaaaaaaaaaaa.unset();
		document.get('content').insert(9, ' while unset');
		await document.whenDurable();
		await waitFor(
			() => peerDocument.get('content').toString() === 'preserved while unset',
		);

		expect(document.get('content').toString()).toBe('preserved while unset');
		await expect(
			table.openDocument('aaaaaaaaaaaaaaaaaaaaaaaa'),
		).rejects.toThrow(/absent record/);
		await document[Symbol.asyncDispose]();
		await peerDocument[Symbol.asyncDispose]();
	} finally {
		await tab[Symbol.asyncDispose]();
		await context.dispose();
	}
});

test('closing a follower does not dispose the elected owner', async () => {
	const context = setup();
	const ownerTab = await context.openTab();
	const followerTab = await context.openTab();
	await followerTab[Symbol.asyncDispose]();
	await Bun.sleep(20);
	try {
		expect(context.activeOwners).toBe(1);
		expect(context.disposeCount).toBe(0);
		const row = await bindNotes(ownerTab).notes.create({ title: 'still open' });
		expect(await bindNotes(ownerTab).notes.get(row.id)).toMatchObject({
			data: { title: 'still open' },
		});
	} finally {
		await ownerTab[Symbol.asyncDispose]();
		await context.dispose();
	}
	expect(context.disposeCount).toBe(1);
});

test('owner loss fails a follower mutation and never replays it', async () => {
	let context: ReturnType<typeof setup>;
	context = setup({
		afterLocalWrite() {
			context.steal();
		},
	});
	const ownerTab = await context.openTab();
	const followerTab = await context.openTab();
	try {
		await expect(
			bindNotes(followerTab).notes.create({ title: 'ambiguous' }),
		).rejects.toThrow(/owner.*changed/i);
		await Bun.sleep(30);
		expect(context.localWriteCount).toBe(1);
		expect(context.openCount).toBe(2);
	} finally {
		await followerTab[Symbol.asyncDispose]().catch(() => undefined);
		await ownerTab[Symbol.asyncDispose]().catch(() => undefined);
		await context.dispose();
	}
});

test('immediate document and page disposal drains admitted document updates', async () => {
	const context = setup();
	const first = await context.openTab();
	let second:
		| Awaited<ReturnType<typeof openBrowserRecordEpicenterForTest>>
		| undefined;
	try {
		const notes = bindNotes(first).notes;
		const row = await notes.create({ title: 'drain' });
		const localDocument = await notes.openDocument(row.id);
		const localTarget = recordDocumentConnectionTarget(localDocument);
		localDocument.get('content').insert(0, 'local');
		await localDocument[Symbol.asyncDispose]();
		expect(() => localDocument.transact(() => undefined)).toThrow(/disposed/);
		expect(() =>
			localTarget.applyUpdate(new Uint8Array(), Symbol('late')),
		).toThrow(/disposed/);

		const acceptedDocument = await notes.openDocument(row.id);
		expect(acceptedDocument.get('content').toString()).toBe('local');
		const authority = new Y.Doc();
		authority.get('accepted').insert(0, 'authority');
		recordDocumentConnectionTarget(acceptedDocument).applyUpdate(
			new Uint8Array(Y.encodeStateAsUpdateV2(authority)),
			Symbol('authority'),
		);
		authority.destroy();
		await first[Symbol.asyncDispose]();

		second = await context.openTab();
		const reopened = await bindNotes(second).notes.openDocument(row.id);
		expect(reopened.get('content').toString()).toBe('local');
		expect(reopened.get('accepted').toString()).toBe('authority');
		await reopened[Symbol.asyncDispose]();
	} finally {
		await second?.[Symbol.asyncDispose]().catch(() => undefined);
		await first[Symbol.asyncDispose]().catch(() => undefined);
		await context.dispose();
	}
});

test('a candidate accepts a newer owner generation after missing its predecessor', async () => {
	const broadcasts = new FakeBroadcastHub();
	const received: BrowserRecordCoordinationMessage[] = [];
	const peer = broadcasts.create('generation-test');
	peer.onmessage = ({ data }) => received.push(data);
	const neverOwner: OpenBrowserRecordWorkerOwner = ({ signal }) =>
		new Promise((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(signal.reason), {
				once: true,
			});
		});
	const worker = new FakeCandidateWorker({
		openOwner: neverOwner,
		createChannel: broadcasts.create,
		candidateId: 'waiting-candidate',
	});
	worker.postMessage({ type: 'start', coordinationId: 'generation-test' });
	await waitFor(() =>
		worker.messages.some((message) => message.type === 'status'),
	);
	peer.postMessage({
		version: 1,
		type: 'owner',
		candidateId: 'owner-1',
		ownerSession: 'session-1',
		ownerGeneration: 1,
	});
	await waitFor(() =>
		worker.messages.some(
			(message) => message.type === 'status' && message.ownerGeneration === 1,
		),
	);

	// Generation 2 is deliberately never announced to this candidate.
	peer.postMessage({
		version: 1,
		type: 'owner',
		candidateId: 'owner-3',
		ownerSession: 'session-3',
		ownerGeneration: 3,
	});
	await waitFor(() =>
		worker.messages.some(
			(message) => message.type === 'status' && message.ownerGeneration === 3,
		),
	);
	worker.postMessage({ type: 'request', id: 42, operation: { kind: 'open' } });
	await waitFor(() =>
		received.some(
			(message) =>
				message.type === 'request' &&
				message.request.id === 42 &&
				message.ownerGeneration === 3,
		),
	);
	peer.postMessage({
		version: 1,
		type: 'response',
		candidateId: 'waiting-candidate',
		ownerSession: 'session-3',
		ownerGeneration: 3,
		message: { type: 'result', id: 42, result: { kind: 'open' } },
	});
	await waitFor(() =>
		worker.messages.some(
			(message) => message.type === 'result' && message.id === 42,
		),
	);
	worker.postMessage({ type: 'close' });
	await waitFor(() => worker.scopeClosed);
	peer.close();
});

test('close waits for an acquired owner that has not returned from open', async () => {
	const releaseOpen = deferred();
	const context = setup({
		afterOwnerAcquired: () => releaseOpen.promise,
	});
	const worker = context.createWorker();
	worker.postMessage({ type: 'start', coordinationId: 'acquired-close-test' });
	await waitFor(() => context.activeOwners === 1);
	worker.postMessage({ type: 'close' });
	await Bun.sleep(20);
	expect(
		worker.messages.some((message) => message.type === 'closed'),
	).toBeFalse();
	expect(worker.scopeClosed).toBeFalse();
	releaseOpen.resolve();
	await waitFor(() =>
		worker.messages.some((message) => message.type === 'closed'),
	);
	expect(context.disposeCount).toBe(1);
	expect(worker.scopeClosed).toBeTrue();
	await context.dispose();
});

test('close waits for in-flight owner-loss disposal', async () => {
	const disposalStarted = deferred();
	const releaseDisposal = deferred();
	const context = setup({
		beforeOwnerDispose: async () => {
			disposalStarted.resolve();
			await releaseDisposal.promise;
		},
	});
	const tab = await context.openTab();
	context.steal();
	await disposalStarted.promise;
	let didClose = false;
	const closing = tab[Symbol.asyncDispose]().then(() => {
		didClose = true;
	});
	await Bun.sleep(20);
	expect(didClose).toBeFalse();
	releaseDisposal.resolve();
	await closing;
	expect(context.disposeCount).toBe(1);
	await context.dispose();
});

test('an initial owner-open failure cleans its worker and permits replacement', async () => {
	const context = setup({ failFirstOpen: true });
	await expect(context.openTab()).rejects.toThrow(/initial owner open failed/);
	expect(context.activeOwners).toBe(0);
	expect(context.waiterCount).toBe(0);
	expect(context.workers[0]?.terminated).toBeTrue();
	expect(context.workers[0]?.scopeClosed).toBeTrue();

	const replacement = await context.openTab();
	expect(context.activeOwners).toBe(1);
	await replacement[Symbol.asyncDispose]();
	await context.dispose();
});

test('worker failure after close starts rejects the close waiter', async () => {
	const disposalStarted = deferred();
	const releaseDisposal = deferred();
	const context = setup({
		beforeOwnerDispose: async () => {
			disposalStarted.resolve();
			await releaseDisposal.promise;
		},
	});
	const tab = await context.openTab();
	const worker = context.workers[0];
	if (worker === undefined) throw new Error('worker was not created');
	const closing = tab[Symbol.asyncDispose]();
	await waitFor(() =>
		worker.inbound.some((message) => message.type === 'close'),
	);
	await disposalStarted.promise;
	worker.fail('failure after close');
	await expect(closing).rejects.toThrow(/failure after close/);
	expect(worker.terminated).toBeTrue();
	releaseDisposal.resolve();
	await waitFor(() => context.activeOwners === 0);
	await context.dispose();
});

test('one throwing revocation subscriber cannot prevent the others', async () => {
	const context = setup();
	const { sink, events } = memorySink();
	const tab = await context.openTab(createLogger('test/browser-record', sink));
	try {
		const notes = bindNotes(tab).notes;
		const row = await notes.create({ title: 'revoke' });
		const document = await notes.openDocument(row.id);
		const target = recordDocumentConnectionTarget(document);
		let observed = 0;
		target.subscribeRevocation(() => {
			throw new Error('subscriber failed');
		});
		target.subscribeRevocation(() => {
			observed += 1;
		});
		await notes.delete(row.id);
		await waitFor(() => observed === 1);
		expect(() => document.get('content')).toThrow(/no longer live/);
		expect(events).toHaveLength(1);
		await document[Symbol.asyncDispose]();
	} finally {
		await tab[Symbol.asyncDispose]();
		await context.dispose();
	}
});

test('worker cleanup attempts every stage and reports aggregate failure', async () => {
	const context = setup({ cleanupFailures: true });
	const tab = await context.openTab();
	await expect(tab[Symbol.asyncDispose]()).rejects.toMatchObject({
		name: 'AggregateError',
	});
	expect(context.cleanupCounts).toEqual({
		records: 1,
		blobs: 1,
		status: 1,
		owner: 1,
		channel: 1,
	});
	expect(context.activeOwners).toBe(0);
	await context.dispose();
});

test('owner integrity is checked before its generation is announced', async () => {
	const order: string[] = [];
	const context = setup({
		integrityCheck: () => {
			order.push('integrity');
		},
	});
	context.broadcasts.onPost = (message) => {
		if (message.type === 'owner') order.push('announcement');
	};
	const tab = await context.openTab();
	expect(order).toEqual(['integrity', 'announcement']);
	await tab[Symbol.asyncDispose]();
	await context.dispose();

	const rejected = setup({
		integrityCheck: () => {
			throw new Error('integrity rejected');
		},
	});
	await expect(rejected.openTab()).rejects.toThrow(/integrity rejected/);
	expect(
		rejected.broadcasts.messages.some((message) => message.type === 'owner'),
	).toBeFalse();
	expect(rejected.activeOwners).toBe(0);
	await rejected.dispose();
});
