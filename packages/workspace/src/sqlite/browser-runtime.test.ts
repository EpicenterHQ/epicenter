/**
 * Browser Workspace Runtime Tests
 *
 * Verifies the page-side Worker protocol without opening OPFS.
 *
 * Key behaviors:
 * - open resolves only with a ready, stable handle; failure rejects terminally
 * - list and update use the public row verbs
 * - KV observation re-reads changed values and detaches cleanly
 * - current-state transport actions cross the boundary
 */

import { afterEach, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { asPrincipalId } from '@epicenter/identity';
import * as Y from '@y/y';
import {
	createAccountBrowserWorkspaceRuntime,
	createDeviceBrowserWorkspaceRuntime,
} from './browser-runtime.js';
import {
	type BrowserRuntimeMessage,
	type BrowserRuntimeRequest,
	isWorkspaceStorageHeldError,
	isWorkspaceStorageMovedError,
} from './browser-runtime-protocol.js';
import { defineTable } from './lens-definition.js';
import { defineWorkspace } from './runtime-definition.js';

const NativeWorker = globalThis.Worker;
const ROW_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

function neverOpenWebSocket(): Promise<WebSocket> {
	return new Promise(() => undefined);
}

class FakeWorker {
	static latest: FakeWorker | undefined;
	static openMode: 'resolve' | 'defer' | 'reject' = 'resolve';
	/** Mirrors the real Worker after a newer tab steals the storage lease. */
	static stolen = false;
	static deferDocumentAppend = false;
	readonly operations: BrowserRuntimeRequest['operation'][] = [];
	readonly manifests: BrowserRuntimeRequest['manifest'][] = [];
	readonly transportResponses: { type: string; pendingReason?: string }[] = [];
	/** Worker-owned durable document update log, keyed by row address. */
	readonly documentLogs = new Map<string, Uint8Array[]>();
	row: Record<string, unknown> | undefined = { title: 'Browser row' };
	theme: 'light' | 'dark' | undefined = 'light';
	private readonly messageListeners = new Set<
		(event: MessageEvent<BrowserRuntimeMessage>) => void
	>();
	private deferredOpen: BrowserRuntimeRequest | undefined;
	private deferredSettlement: BrowserRuntimeRequest | undefined;
	private deferredDocumentAppend: BrowserRuntimeRequest | undefined;
	terminated = false;

	constructor() {
		FakeWorker.latest = this;
		queueMicrotask(() => this.emit({ type: 'ready' }));
	}

	addEventListener(
		type: string,
		listener: (event: MessageEvent<never>) => void,
	) {
		if (type === 'message') this.messageListeners.add(listener as never);
	}

	postMessage(message: BrowserRuntimeRequest | { type: string }): void {
		if ('type' in message) {
			this.transportResponses.push(message);
			return;
		}
		this.operations.push(message.operation);
		this.manifests.push(message.manifest);
		if (FakeWorker.stolen) {
			queueMicrotask(() => {
				this.emit({
					type: 'error',
					id: message.id,
					name: 'WorkspaceStorageMovedError',
					message: 'Workspace storage moved to a newer tab',
				});
			});
			return;
		}
		if (message.operation.kind === 'open') {
			if (FakeWorker.openMode === 'defer') {
				this.deferredOpen = message;
				return;
			}
			queueMicrotask(() => {
				if (FakeWorker.openMode === 'reject') {
					// Mirrors the real Worker's terminal acquisition failure: the
					// named held-storage contract crossing the message boundary.
					this.emit({
						type: 'error',
						id: message.id,
						name: 'WorkspaceStorageHeldError',
						message: 'Workspace storage is held by another tab or window',
					});
					return;
				}
				this.emit({ type: 'result', id: message.id, value: { isReady: true } });
			});
			return;
		}
		if (message.operation.kind === 'sync-settle') {
			this.deferredSettlement = message;
			this.finishSettlement();
			return;
		}
		if (
			message.operation.kind === 'document-append' &&
			FakeWorker.deferDocumentAppend
		) {
			this.deferredDocumentAppend = message;
			return;
		}
		const value = (() => {
			switch (message.operation.kind) {
				case 'logical-capture':
				case 'capture-visible':
				case 'sync-capture-recovery': {
					// The real Worker folds each row's compact document state from
					// its co-located SQLite log into the copy.
					const document = this.captureDocument('notes', ROW_ID);
					return {
						rows: [
							{
								table: 'notes',
								rowId: ROW_ID,
								fields: { title: 'Browser row' },
								...(document === undefined ? {} : { document }),
							},
						],
						kv: { theme: 'light' },
					};
				}
				case 'document-load': {
					const key = `${message.operation.table}\0${message.operation.rowId}`;
					return (this.documentLogs.get(key) ?? []).map(
						(update) => new Uint8Array(update),
					);
				}
				case 'document-append': {
					const key = `${message.operation.table}\0${message.operation.rowId}`;
					const log = this.documentLogs.get(key) ?? [];
					log.push(new Uint8Array(message.operation.update));
					this.documentLogs.set(key, log);
					return undefined;
				}
				case 'logical-add': {
					// Mirrors the real Worker: after admitting scalar rows it appends
					// each copied document snapshot into its own co-located log.
					for (const row of message.operation.copy.rows) {
						if (row.document === undefined) continue;
						const key = `${row.table}\0${row.rowId}`;
						const log = this.documentLogs.get(key) ?? [];
						log.push(new Uint8Array(row.document));
						this.documentLogs.set(key, log);
					}
					return undefined;
				}
				case 'logical-delete':
					this.row = undefined;
					this.theme = undefined;
					return undefined;
				case 'read-current-row':
					return this.row;
				case 'kv-get':
					return { data: this.theme, error: null };
				case 'kv-set':
					this.theme = message.operation.value as 'light' | 'dark';
					return { data: undefined, error: null };
				case 'kv-unset':
					this.theme = undefined;
					return undefined;
				case 'delete':
					this.row = undefined;
					return undefined;
				default:
					return undefined;
			}
		})();
		queueMicrotask(() => {
			this.emit({ type: 'result', id: message.id, value });
		});
	}

	resolveOpen(): void {
		const request = this.deferredOpen;
		if (!request) throw new Error('No deferred open request');
		this.deferredOpen = undefined;
		this.emit({ type: 'result', id: request.id, value: { isReady: true } });
	}

	resolveDocumentAppend(): void {
		const request = this.deferredDocumentAppend;
		if (!request || request.operation.kind !== 'document-append') {
			throw new Error('No deferred document append request');
		}
		this.deferredDocumentAppend = undefined;
		const key = `${request.operation.table}\0${request.operation.rowId}`;
		const log = this.documentLogs.get(key) ?? [];
		log.push(new Uint8Array(request.operation.update));
		this.documentLogs.set(key, log);
		this.emit({ type: 'result', id: request.id, value: undefined });
	}

	private captureDocument(
		table: string,
		rowId: string,
	): Uint8Array | undefined {
		const updates = this.documentLogs.get(`${table}\0${rowId}`);
		if (!updates || updates.length === 0) return undefined;
		const folded = new Y.Doc();
		try {
			for (const update of updates) Y.applyUpdateV2(folded, update);
			return new Uint8Array(Y.encodeStateAsUpdateV2(folded));
		} finally {
			folded.destroy();
		}
	}

	private finishSettlement(): void {
		const request = this.deferredSettlement;
		if (!request) return;
		this.deferredSettlement = undefined;
		queueMicrotask(() => {
			this.emit({
				type: 'result',
				id: request.id,
				value: { outcome: 'caught-up' },
			});
		});
	}

	emit(message: BrowserRuntimeMessage): void {
		for (const listener of this.messageListeners) {
			listener(new MessageEvent('message', { data: message }));
		}
	}

	terminate(): void {
		this.terminated = true;
	}
}

afterEach(() => {
	globalThis.Worker = NativeWorker;
	FakeWorker.latest = undefined;
	FakeWorker.openMode = 'resolve';
	FakeWorker.stolen = false;
	FakeWorker.deferDocumentAppend = false;
});

const definition = defineWorkspace({
	id: 'browser-test',
	tables: {
		notes: defineTable({ fields: { title: field.string() } }),
	},
	kv: { theme: field.select(['light', 'dark']) },
});

function createRuntime() {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	return createDeviceBrowserWorkspaceRuntime({
		createBroadcastChannel: () => undefined,
	});
}

test('open resolves only with a ready handle and reopening is stable', async () => {
	FakeWorker.openMode = 'defer';
	await using runtime = createRuntime();
	let ready = false;
	const opening = runtime.open(definition).then((handle) => {
		ready = true;
		return handle;
	});
	// Reopening before readiness shares the one storage-opening attempt.
	expect(runtime.open(definition)).toBe(runtime.open(definition));
	await Promise.resolve();
	await Promise.resolve();
	expect(ready).toBe(false);
	expect(FakeWorker.latest?.operations[0]).toEqual({ kind: 'open' });
	FakeWorker.latest?.resolveOpen();
	const workspace = await opening;
	await workspace.tables.notes.list();
	// The handle is stable: reopening resolves the same object.
	expect(await runtime.open(definition)).toBe(workspace);
	expect(
		FakeWorker.latest?.operations.filter(({ kind }) => kind === 'open'),
	).toEqual([{ kind: 'open' }]);
});

test('failed acquisition is terminal: open rejects and never retries', async () => {
	FakeWorker.openMode = 'reject';
	await using runtime = createRuntime();
	const failure = await runtime.open(definition).then(
		() => undefined,
		(cause: unknown) => cause,
	);
	expect(failure).toBeInstanceOf(Error);
	expect(isWorkspaceStorageHeldError(failure)).toBe(true);
	// The same terminal rejection, with no second acquisition attempt behind
	// a later open.
	await expect(runtime.open(definition)).rejects.toThrow('held by another tab');
	expect(
		FakeWorker.latest?.operations.filter(({ kind }) => kind === 'open'),
	).toEqual([{ kind: 'open' }]);
});

test('Account manifest owns only Account storage and never references Device', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	await using accountRuntime = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
			},
		},
		createBroadcastChannel: () => undefined,
	});
	await accountRuntime.open(definition);
	const accountManifest = FakeWorker.latest?.manifests[0];
	const accountStorageKey = accountManifest?.storageKey;
	expect(accountStorageKey).toBeString();
	expect(Object.hasOwn(accountManifest ?? {}, 'additionSourceStorageKey')).toBe(
		false,
	);

	await accountRuntime[Symbol.asyncDispose]();
	await using deviceRuntime = createRuntime();
	await deviceRuntime.open(definition);
	expect(FakeWorker.latest?.manifests[0]?.storageKey).not.toBe(
		accountStorageKey,
	);
});

test('Device capture/delete and Account add are explicit logical actions', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	let copy: Awaited<ReturnType<ReturnType<typeof createRuntime>['capture']>>;
	{
		await using device = createRuntime();
		copy = await device.capture(definition);
		expect(copy.rows[0]).toMatchObject({
			table: 'notes',
			rowId: ROW_ID,
			fields: { title: 'Browser row' },
		});
		await device.delete(definition);
		expect(FakeWorker.latest?.operations.at(-1)).toEqual({
			kind: 'logical-delete',
		});
	}

	await using account = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
			},
		},
		createBroadcastChannel: () => undefined,
	});
	await account.add(definition, copy);
	expect(FakeWorker.latest?.operations.at(-1)).toEqual({
		kind: 'logical-add',
		copy,
	});
});

test('Account add makes copied document snapshots durable owner-side', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	const authored = new Y.Doc();
	authored.get('content').insert(0, 'carried over');
	const snapshot = new Uint8Array(Y.encodeStateAsUpdateV2(authored));
	authored.destroy();

	await using account = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
			},
		},
		createBroadcastChannel: () => undefined,
	});
	await account.add(definition, {
		rows: [
			{ table: 'notes', rowId: ROW_ID, fields: { title: 'Migrated' }, document: snapshot },
		],
		kv: {},
	});

	// The snapshot rode inside logical-add; the page never re-ships it as a
	// separate document-append round trip.
	const kinds = FakeWorker.latest?.operations.map(({ kind }) => kind);
	expect(kinds).not.toContain('document-append');
	expect(kinds?.at(-1)).toBe('logical-add');

	// The owner made it durable, so opening the row hydrates the imported content.
	const workspace = await account.open(definition);
	using document = await workspace.tables.notes.document.open(ROW_ID);
	expect(document.get('content').toString()).toBe('carried over');
});

test('Device export reports a null settlement over the local capture', async () => {
	await using runtime = createRuntime();
	const exported = await runtime.export(definition);
	expect(exported.settlement).toBeNull();
	expect(exported.rows[0]).toMatchObject({ table: 'notes', rowId: ROW_ID });
	expect(FakeWorker.latest?.operations.at(-1)).toEqual({
		kind: 'logical-capture',
	});
});

test('Account export settles first, then captures visible state with documents', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	await using runtime = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
			},
		},
		createBroadcastChannel: () => undefined,
	});
	const workspace = await runtime.open(definition);
	{
		using document = await workspace.tables.notes.document.open(ROW_ID);
		document.get('content').insert(0, 'export me');
		await document.whenDurable();
	}
	const exported = await runtime.export(definition);
	expect(exported.settlement).toEqual({ outcome: 'caught-up' });
	expect(exported.rows[0]?.document).toBeInstanceOf(Uint8Array);
	const kinds = FakeWorker.latest?.operations.map(
		(operation) => operation.kind,
	);
	expect(kinds?.indexOf('sync-settle')).toBeLessThan(
		kinds?.indexOf('capture-visible') ?? -1,
	);
});

test('page sends list and update operations', async () => {
	await using runtime = createRuntime();
	const workspace = await runtime.open(definition);
	await workspace.tables.notes.list();
	await workspace.tables.notes.update('aaaaaaaaaaaaaaaaaaaaaaaa', {
		title: 'changed',
	});
	expect(FakeWorker.latest?.operations).toEqual([
		{ kind: 'open' },
		{ kind: 'list', table: 'notes' },
		{
			kind: 'update',
			table: 'notes',
			id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			changes: { title: 'changed' },
		},
	]);
});

test('browser row documents persist through the Worker-owned update log', async () => {
	await using runtime = createRuntime();
	const workspace = await runtime.open(definition);
	{
		using document = await workspace.tables.notes.document.open(ROW_ID);
		document.get('content').insert(0, 'local');
		await document.whenDurable();
		expect(document.get('content').toString()).toBe('local');
	}
	const kinds = FakeWorker.latest?.operations.map(({ kind }) => kind);
	expect(kinds).toContain('document-load');
	expect(kinds).toContain('document-append');
	// A later open hydrates the same content back from the Worker's log.
	using reopened = await workspace.tables.notes.document.open(ROW_ID);
	expect(reopened.get('content').toString()).toBe('local');
});

test('worker transport uses the workspace record routes', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	const requests: { url: string; method: string }[] = [];
	await using runtime = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
				async fetch(input, init) {
					requests.push({ url: String(input), method: init?.method ?? 'GET' });
					return new Response('{}', {
						status: 200,
						headers: { 'content-type': 'application/json' },
					});
				},
			},
		},
		createBroadcastChannel: () => undefined,
	});
	const workspace = await runtime.open(definition);
	await workspace.tables.notes.list();
	for (const action of ['push', 'pull', 'acquire'] as const) {
		FakeWorker.latest?.emit({
			type: 'transport-request',
			transportId: requests.length + 1,
			workspaceId: definition.id,
			action,
			body: {},
		});
		await Promise.resolve();
		await Promise.resolve();
	}
	expect(
		requests.map(({ url, method }) => [new URL(url).pathname, method]),
	).toEqual([
		['/api/workspaces/browser-test/records/push', 'POST'],
		['/api/workspaces/browser-test/records/pull', 'POST'],
		['/api/workspaces/browser-test/records/acquire', 'POST'],
	]);
});

test('settlement is one scalar Worker operation', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	await using runtime = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
			},
		},
		createBroadcastChannel: () => undefined,
	});
	const workspace = await runtime.open(definition);
	expect(await workspace.sync?.settle()).toEqual({ outcome: 'caught-up' });
	expect(FakeWorker.latest?.operations.at(-1)).toEqual({ kind: 'sync-settle' });
});

test('Account sync status is reactive across the Worker boundary', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	await using runtime = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
			},
		},
		createBroadcastChannel: () => undefined,
	});
	const workspace = await runtime.open(definition);
	const statuses: unknown[] = [];
	const unsubscribe = workspace.sync?.onStatusChange((status) => {
		statuses.push(status);
	});
	FakeWorker.latest?.emit({
		type: 'sync-status',
		workspaceId: definition.id,
		status: { phase: 'pending', reason: 'authentication' },
	});

	expect(workspace.sync?.status).toEqual({
		phase: 'pending',
		reason: 'authentication',
	});
	expect(statuses).toEqual([{ phase: 'pending', reason: 'authentication' }]);
	FakeWorker.latest?.emit({
		type: 'sync-status',
		workspaceId: definition.id,
		status: { phase: 'recovery-required', reason: 'lineage-mismatch' },
	});
	{
		using document = await workspace.tables.notes.document.open(ROW_ID);
		document.get('content').insert(0, 'recover me');
		await document.whenDurable();
	}
	const copy = await workspace.sync?.captureRecovery();
	expect(copy).toMatchObject({
		rows: [{ table: 'notes', rowId: ROW_ID }],
	});
	// The Worker folds locally durable document state from its co-located
	// SQLite log into the recovery copy (ADR-0142's compact document state).
	expect(copy?.rows[0]?.document).toBeInstanceOf(Uint8Array);
	unsubscribe?.();
});

test('a storage steal rejects document work with the moved error', async () => {
	await using runtime = createRuntime();
	const workspace = await runtime.open(definition);
	using document = await workspace.tables.notes.document.open(ROW_ID);
	FakeWorker.stolen = true;
	document.get('content').insert(0, 'after steal');
	const failure = await document.whenDurable().then(
		() => undefined,
		(cause: unknown) => cause,
	);
	expect(failure).toBeInstanceOf(Error);
	expect(isWorkspaceStorageMovedError(failure)).toBe(true);
});

test('disposal drains admitted document appends before terminating the Worker', async () => {
	const runtime = createRuntime();
	const workspace = await runtime.open(definition);
	const document = await workspace.tables.notes.document.open(ROW_ID);
	FakeWorker.deferDocumentAppend = true;
	document.get('content').insert(0, 'durable before shutdown');
	const durability = document.whenDurable();
	await waitFor(() =>
		Boolean(
			FakeWorker.latest?.operations.some(
				(operation) => operation.kind === 'document-append',
			),
		),
	);
	const disposal = runtime[Symbol.asyncDispose]();
	await Promise.resolve();
	expect(FakeWorker.latest?.terminated).toBeFalse();
	FakeWorker.latest?.resolveDocumentAppend();
	const durabilityFailure = await durability.then(
		() => undefined,
		(cause: unknown) => cause,
	);
	expect(durabilityFailure).toBeInstanceOf(Error);
	await disposal;
	expect(FakeWorker.latest?.documentLogs.get(`notes\0${ROW_ID}`)).toHaveLength(
		1,
	);
	expect(FakeWorker.latest?.terminated).toBeTrue();
});

test('storage-moved notification aborts a stalled authority fetch', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	let signal: AbortSignal | undefined;
	await using runtime = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
				fetch(_input, init) {
					signal = init?.signal ?? undefined;
					return new Promise<Response>((_resolve, reject) => {
						signal?.addEventListener('abort', () => reject(signal?.reason), {
							once: true,
						});
					});
				},
			},
		},
		createBroadcastChannel: () => undefined,
	});
	await runtime.open(definition);
	FakeWorker.latest?.emit({
		type: 'transport-request',
		transportId: 1,
		workspaceId: definition.id,
		action: 'pull',
		body: {},
	});
	await waitFor(() => signal !== undefined);
	FakeWorker.latest?.emit({
		type: 'background-error',
		workspaceId: definition.id,
		name: 'WorkspaceStorageMovedError',
		message: 'Workspace storage moved to a newer tab',
	});
	await waitFor(() => signal?.aborted === true);
	expect(signal?.aborted).toBeTrue();
	await waitFor(() =>
		Boolean(
			FakeWorker.latest?.transportResponses.some(
				(response) => response.type === 'transport-error',
			),
		),
	);
});

test('browser transport serializes only known interruptions as retryable', async () => {
	globalThis.Worker = FakeWorker as unknown as typeof Worker;
	await using runtime = createAccountBrowserWorkspaceRuntime({
		account: {
			deploymentId: 'https://example.test',
			principalId: asPrincipalId('alice'),
			transport: {
				baseUrl: 'https://example.test',
				openWebSocket: neverOpenWebSocket,
				async fetch(input) {
					const action = new URL(String(input)).pathname.split('/').at(-1);
					switch (action) {
						case 'push':
							return Response.json({}, { status: 401 });
						case 'pull':
							return new Response('temporary proxy failure', { status: 503 });
						case 'acquire':
							return Response.json({}, { status: 400 });
						default:
							throw new Error('Unexpected action');
					}
				},
			},
		},
		createBroadcastChannel: () => undefined,
	});
	await runtime.open(definition);
	const actions = ['push', 'pull', 'acquire'] as const;
	for (const action of actions) {
		FakeWorker.latest?.emit({
			type: 'transport-request',
			transportId: FakeWorker.latest.transportResponses.length + 1,
			workspaceId: definition.id,
			action,
			body: {},
		});
		await waitFor(
			() =>
				(FakeWorker.latest?.transportResponses.length ?? 0) >
				actions.indexOf(action),
		);
	}

	expect(FakeWorker.latest?.transportResponses).toMatchObject([
		{ type: 'transport-error', pendingReason: 'authentication' },
		{ type: 'transport-error', pendingReason: 'retrying' },
		{ type: 'transport-error' },
	]);
	expect(FakeWorker.latest?.transportResponses[2]).not.toHaveProperty(
		'pendingReason',
	);
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for browser');
		await Bun.sleep(5);
	}
}
