/**
 * Desktop Universal-Record Transport Tests
 *
 * Drives trusted WebView clients through the JSON carrier into one in-memory
 * Bun host owner. The tests keep Lens schemas and Yjs handles on the page side.
 *
 * Key behaviors:
 * - protocol requests, results, and events are JSON-native and cloneable
 * - create-with-blob admits one complete record without a compensating delete
 * - native capture tokens resolve only in the host and release after admission
 * - page-local documents persist and revoke through the host owner
 * - attachment and sanitized sync state cross the observable event boundary
 * - stale surface generations cannot mutate the current owner
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import type {
	BlobFileStore,
	OwnedBlobFile,
	StagedBlob,
} from './blob-v1/index.js';
import type {
	DesktopRecordNativeCapture,
	DesktopRecordRequest,
	DesktopRecordResponse,
} from './desktop-record/protocol.js';
import {
	EPICENTER_DESKTOP_RECORD_MOVED_ERROR_NAME,
	MAX_RECORD_BLOB_BYTES,
} from './desktop-record/protocol.js';
import { openDesktopRecordEpicenterForTest } from './desktop-record.js';
import { createDesktopRecordEpicenterOwnerForTest } from './desktop-record-owner.js';
import { defineLens, defineTable, defineValues } from './lens.js';
import { sha256HexBytes } from './protocol/v1/canonical.js';
import { makeLimits } from './protocol/v1/kernel.test-support.js';
import { createRecordOwner } from './record-epicenter.js';
import {
	createReplicaBlobStore,
	openReplicaStore,
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

const notesLens = defineLens({
	namespace: 'so.epicenter.desktop-notes',
	title: 'Desktop notes',
	description: 'Desktop record transport test.',
	collections: {
		notes: defineTable({
			title: 'Notes',
			fields: { title: field.string(), body: field.string() },
			optional: ['body'],
		}),
		settings: defineValues({
			title: 'Settings',
			values: { theme: field.select(['light', 'dark']) },
		}),
	},
});

type Setup = ReturnType<typeof setup>;
type TestNativeCaptureResolver = (
	capture: DesktopRecordNativeCapture,
) => Promise<{ source: Blob; release(): void | Promise<void> }>;
type TextRoot = {
	insert(index: number, value: string): void;
	toString(): string;
};

function setup(
	ownerOptions: Parameters<
		typeof createDesktopRecordEpicenterOwnerForTest
	>[1] = {},
	{
		resolveNativeCapture,
		failAdmission = false,
		onAdmission,
	}: {
		resolveNativeCapture?: TestNativeCaptureResolver;
		failAdmission?: boolean;
		onAdmission?: () => void;
	} = {},
) {
	const database = new Database(':memory:', { strict: true });
	const adapter = createBunSqliteAdapter(database);
	const replica = openReplicaStore({
		database: adapter,
		limits: makeLimits(),
		initialize: { replicaId: 'dddddddddddddddddddddddd' },
	});
	const files = new MemoryBlobFiles();
	const blobs = createReplicaBlobStore(adapter, files);
	const recordOwner = createRecordOwner({ replica, blobs });
	const ownerReplica =
		failAdmission || onAdmission !== undefined
			? {
					...replica,
					admitLocalRecordWithBlob(
						input: Parameters<typeof replica.admitLocalRecordWithBlob>[0],
					) {
						onAdmission?.();
						if (failAdmission) throw new Error('injected admission failure');
						return replica.admitLocalRecordWithBlob(input);
					},
				}
			: replica;
	const owner = createDesktopRecordEpicenterOwnerForTest(
		{
			owner: recordOwner,
			replica: ownerReplica,
			blobs,
			decodeBlob: (value) =>
				new Blob([new Uint8Array(Buffer.from(value, 'base64'))]),
			encodeBlob: async (value) =>
				Buffer.from(await value.arrayBuffer()).toString('base64'),
			resolveNativeCapture,
		},
		ownerOptions,
	);
	const exchanges: unknown[] = [];
	const fetch = createRouteFetch(owner, exchanges);
	return { database, replica, files, owner, fetch, exchanges };
}

function createRouteFetch(
	owner: ReturnType<typeof createDesktopRecordEpicenterOwnerForTest>,
	exchanges: unknown[],
) {
	return async (
		_input: Parameters<typeof globalThis.fetch>[0],
		init?: Parameters<typeof globalThis.fetch>[1],
	): Promise<Response> => {
		const request = JSON.parse(String(init?.body)) as DesktopRecordRequest;
		const clonedRequest = structuredClone(request);
		exchanges.push(clonedRequest);
		const envelope: DesktopRecordResponse = structuredClone(
			await owner.execute(clonedRequest),
		);
		exchanges.push(envelope.result ?? envelope.error);
		return new Response(JSON.stringify(envelope), {
			status: envelope.error === null ? 200 : 409,
			headers: { 'content-type': 'application/json' },
		});
	};
}

async function openPage(
	context: Setup,
	{
		fetch = context.fetch,
		pollIntervalMs = 1,
		requestTimeoutMs = 100,
	}: {
		fetch?: Setup['fetch'];
		pollIntervalMs?: number;
		requestTimeoutMs?: number;
	} = {},
) {
	return openDesktopRecordEpicenterForTest({
		baseUrl: 'http://desktop.test',
		fetch,
		pollIntervalMs,
		requestTimeoutMs,
	});
}

async function eventually(
	assertion: () => void | Promise<void>,
): Promise<void> {
	let cause: unknown;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			await assertion();
			return;
		} catch (nextCause) {
			cause = nextCause;
			await Bun.sleep(2);
		}
	}
	throw cause;
}

async function dispose(
	context: Setup,
	...pages: Awaited<ReturnType<typeof openPage>>[]
) {
	for (const page of pages) await page[Symbol.asyncDispose]();
	await context.owner[Symbol.asyncDispose]();
	context.database.close();
}

test('page Lens CRUD and create-with-blob cross one JSON-native owner protocol', async () => {
	const context = setup();
	const page = await openPage(context);
	try {
		const notes = page.bind({ notes: notesLens }).notes;
		const invalidated: string[][] = [];
		notes.notes.subscribe((ids) => invalidated.push(ids));
		const row = await notes.notes.createWithBlob(
			{ title: 'Atomic' },
			{ kind: 'bytes', bytes: new Blob(['record bytes']) },
		);
		expect(await notes.notes.get(row.id)).toMatchObject({
			data: { id: row.id, title: 'Atomic' },
			error: null,
		});
		expect(await notes.notes.blob.inspect(row.id)).toMatchObject({
			kind: 'pending',
		});
		expect(await (await notes.notes.blob.get(row.id))?.text()).toBe(
			'record bytes',
		);
		await notes.settings.theme.set('dark');
		expect(await notes.settings.theme.get()).toMatchObject({ data: 'dark' });
		await eventually(() => expect(invalidated.flat()).toContain(row.id));
		for (const exchange of context.exchanges) {
			expect(structuredClone(exchange)).toEqual(exchange);
			expect(JSON.parse(JSON.stringify(exchange))).toEqual(exchange);
		}
	} finally {
		await dispose(context, page);
	}
});

test('native create request stays JSON-native and releases its source after admission', async () => {
	const order: string[] = [];
	const bytes = new Blob(['native recording']);
	const capture = {
		kind: 'native-capture' as const,
		captureId: 'capture_0123456789abcdef0123456789abcdef',
		byteLength: bytes.size,
		acknowledgeAdmission() {},
	};
	const coordinate = {
		kind: capture.kind,
		captureId: capture.captureId,
		byteLength: capture.byteLength,
	};
	const context = setup(
		{},
		{
			onAdmission: () => order.push('admit'),
			async resolveNativeCapture(received) {
				order.push('resolve');
				expect(received).toEqual(coordinate);
				return {
					source: bytes,
					release() {
						order.push('release');
					},
				};
			},
		},
	);
	const page = await openPage(context);
	try {
		const notes = page.bind({ notes: notesLens }).notes.notes;
		const row = await notes.createWithBlob({ title: 'Native' }, capture);
		expect(order).toEqual(['resolve', 'admit', 'release']);
		const retried = await notes.createWithBlob({ title: 'Native' }, capture);
		expect(retried.id).toBe(row.id);
		expect(order).toEqual(['resolve', 'admit', 'release']);
		const recovered = await notes.createWithBlob(
			{ title: 'Different payload' },
			capture,
		);
		expect(recovered).toEqual(row);
		expect(order).toHaveLength(3);
		expect(await (await notes.blob.get(row.id))?.text()).toBe(
			'native recording',
		);
		const request = context.exchanges.find(
			(exchange): exchange is DesktopRecordRequest =>
				typeof exchange === 'object' &&
				exchange !== null &&
				'operation' in exchange &&
				(exchange as DesktopRecordRequest).operation.kind ===
					'create-record-with-blob',
		);
		expect(request?.operation).toMatchObject({ source: coordinate });
		expect(JSON.stringify(request)).not.toContain('native recording');
		expect(JSON.stringify(request)).not.toContain('bytesBase64');
	} finally {
		await dispose(context, page);
	}
});

test('native capture source releases when record admission fails', async () => {
	let releases = 0;
	const bytes = new Blob(['retain me']);
	const context = setup(
		{},
		{
			failAdmission: true,
			async resolveNativeCapture() {
				return {
					source: bytes,
					release() {
						releases += 1;
					},
				};
			},
		},
	);
	const page = await openPage(context);
	try {
		const notes = page.bind({ notes: notesLens }).notes.notes;
		await expect(
			notes.createWithBlob(
				{ title: 'Not admitted' },
				{
					kind: 'native-capture',
					captureId: 'capture_1123456789abcdef0123456789abcdef',
					byteLength: bytes.size,
				},
			),
		).rejects.toThrow('Desktop record operation failed');
		expect(releases).toBe(1);
		expect((await notes.scan()).rows).toEqual([]);
	} finally {
		await dispose(context, page);
	}
});

test('invalid native capture IDs and lengths are refused before resolution', async () => {
	const invalidCaptures: DesktopRecordNativeCapture[] = [
		{
			kind: 'native-capture',
			captureId: '../../recording.wav',
			byteLength: 12,
		},
		{
			kind: 'native-capture',
			captureId: 'capture_0123456789abcdef0123456789abcdeF',
			byteLength: 12,
		},
		{
			kind: 'native-capture',
			captureId: 'capture_0123456789abcdef0123456789abcdef',
			byteLength: 0,
		},
		{
			kind: 'native-capture',
			captureId: 'capture_0123456789abcdef0123456789abcdef',
			byteLength: 1.5,
		},
		{
			kind: 'native-capture',
			captureId: 'capture_0123456789abcdef0123456789abcdef',
			byteLength: MAX_RECORD_BLOB_BYTES + 1,
		},
	];
	for (const capture of invalidCaptures) {
		let resolutions = 0;
		const context = setup(
			{},
			{
				async resolveNativeCapture() {
					resolutions += 1;
					return { source: new Blob(), release() {} };
				},
			},
		);
		const page = await openPage(context);
		try {
			const notes = page.bind({ notes: notesLens }).notes.notes;
			await expect(
				notes.createWithBlob({ title: 'Invalid capture' }, capture),
			).rejects.toThrow('Desktop record request is invalid');
			expect(resolutions).toBe(0);
		} finally {
			await dispose(context, page);
		}
	}
});

test('native resolver stat refusal retains the capture and admits no row', async () => {
	let resolutions = 0;
	const bytes = new Blob(['stat mismatch']);
	const capture = {
		kind: 'native-capture' as const,
		captureId: 'capture_3123456789abcdef0123456789abcdef',
		byteLength: bytes.size + 1,
	};
	const context = setup(
		{},
		{
			async resolveNativeCapture(received) {
				resolutions += 1;
				if (received.byteLength !== bytes.size) {
					throw new Error('native capture stat changed');
				}
				return { source: bytes, release() {} };
			},
		},
	);
	const page = await openPage(context);
	try {
		const notes = page.bind({ notes: notesLens }).notes.notes;
		await expect(
			notes.createWithBlob({ title: 'Stat refused' }, capture),
		).rejects.toThrow('Desktop record operation failed');
		expect(resolutions).toBe(1);
		expect((await notes.scan()).rows).toEqual([]);
	} finally {
		await dispose(context, page);
	}
});

test('oversized inline Blob is refused before materialization or transport', async () => {
	const context = setup();
	const page = await openPage(context);
	let materialized = false;
	const oversized = new Blob();
	Object.defineProperties(oversized, {
		size: { value: MAX_RECORD_BLOB_BYTES + 1 },
		arrayBuffer: {
			value: () => {
				materialized = true;
				return Promise.resolve(new ArrayBuffer(0));
			},
		},
	});
	try {
		const notes = page.bind({ notes: notesLens }).notes.notes;
		await expect(
			notes.createWithBlob(
				{ title: 'Too large' },
				{ kind: 'bytes', bytes: oversized },
			),
		).rejects.toThrow('exceeds');
		expect(materialized).toBe(false);
		expect(
			context.exchanges.some(
				(exchange) =>
					typeof exchange === 'object' &&
					exchange !== null &&
					'operation' in exchange &&
					(exchange as DesktopRecordRequest).operation.kind ===
						'create-record-with-blob',
			),
		).toBe(false);
	} finally {
		await dispose(context, page);
	}
});

test('native cleanup failure retries one deterministic record after a page reload', async () => {
	let opens = 0;
	let removals = 0;
	const bytes = new Blob(['durable native bytes']);
	const context = setup(
		{},
		{
			async resolveNativeCapture() {
				opens += 1;
				return {
					source: bytes,
					release() {
						removals += 1;
						if (removals === 1) {
							throw new Error('capture is temporarily locked');
						}
					},
				};
			},
		},
	);
	let page = await openPage(context);
	try {
		const source = {
			kind: 'native-capture' as const,
			captureId: 'capture_2123456789abcdef0123456789abcdef',
			byteLength: bytes.size,
		};
		await expect(
			page
				.bind({ notes: notesLens })
				.notes.notes.createWithBlob({ title: 'Original capture' }, source),
		).rejects.toThrow('Desktop record operation failed');
		await page[Symbol.asyncDispose]().catch(() => undefined);
		page = await openPage(context);
		const notes = page.bind({ notes: notesLens }).notes.notes;
		const row = await notes.createWithBlob(
			{ title: 'Original capture' },
			source,
		);
		expect(row.id).toHaveLength(24);
		expect(row.title).toBe('Original capture');
		expect((await notes.scan()).rows).toEqual([
			{ id: row.id, title: 'Original capture' },
		]);
		expect(opens).toBe(1);
		expect(removals).toBe(1);
	} finally {
		await dispose(context, page);
	}
});

test('native admission survives two lost responses and replays after a page reload', async () => {
	let resolutions = 0;
	let releases = 0;
	const bytes = new Blob(['response-loss native bytes']);
	const context = setup(
		{},
		{
			async resolveNativeCapture() {
				resolutions += 1;
				return {
					source: bytes,
					release() {
						releases += 1;
					},
				};
			},
		},
	);
	let losses = 0;
	const lostResponses: Setup['fetch'] = async (input, init) => {
		const request = JSON.parse(String(init?.body)) as DesktopRecordRequest;
		const response = await context.fetch(input, init);
		if (request.operation.kind === 'create-record-with-blob' && losses < 2) {
			losses += 1;
			throw new Error('response lost after admission');
		}
		return response;
	};
	let page = await openPage(context, { fetch: lostResponses });
	try {
		const source = {
			kind: 'native-capture' as const,
			captureId: 'capture_3123456789abcdef0123456789abcdef',
			byteLength: bytes.size,
		};
		await expect(
			page
				.bind({ notes: notesLens })
				.notes.notes.createWithBlob({ title: 'Before reload' }, source),
		).rejects.toThrow();
		await page[Symbol.asyncDispose]().catch(() => undefined);
		page = await openPage(context);

		const notes = page.bind({ notes: notesLens }).notes.notes;
		const recovered = await notes.createWithBlob(
			{ title: 'Before reload' },
			source,
		);
		expect(recovered.title).toBe('Before reload');
		expect((await notes.scan()).rows).toEqual([
			{ id: recovered.id, title: 'Before reload' },
		]);
		expect(resolutions).toBe(1);
		expect(releases).toBe(1);
	} finally {
		await dispose(context, page);
	}
});

test('a lost create-with-blob response replays one admitted row and its original key', async () => {
	const context = setup();
	let dropped = false;
	const flakyFetch: Setup['fetch'] = async (input, init) => {
		const request = JSON.parse(String(init?.body)) as DesktopRecordRequest;
		const response = await context.fetch(input, init);
		if (!dropped && request.operation.kind === 'create-record-with-blob') {
			dropped = true;
			throw new Error('response lost after commit');
		}
		return response;
	};
	const page = await openPage(context, { fetch: flakyFetch });
	try {
		const notes = page.bind({ notes: notesLens }).notes.notes;
		const row = await notes.createWithBlob(
			{ title: 'One row' },
			{ kind: 'bytes', bytes: new Blob(['one blob']) },
		);
		expect(dropped).toBe(true);
		expect((await notes.scan()).rows).toEqual([
			{ id: row.id, title: 'One row' },
		]);
		expect(await (await notes.blob.get(row.id))?.text()).toBe('one blob');
		const attempts = context.exchanges.filter(
			(exchange): exchange is DesktopRecordRequest =>
				typeof exchange === 'object' &&
				exchange !== null &&
				'operation' in exchange &&
				(exchange as DesktopRecordRequest).operation.kind ===
					'create-record-with-blob',
		);
		expect(attempts).toHaveLength(2);
		expect(attempts[0]?.mutationId).toBe(attempts[1]?.mutationId);
	} finally {
		await dispose(context, page);
	}
});

test('a lost event response replays the same cursor without duplicate invalidation', async () => {
	const context = setup();
	let dropped = false;
	const flakyFetch: Setup['fetch'] = async (input, init) => {
		const request = JSON.parse(String(init?.body)) as DesktopRecordRequest;
		const response = await context.fetch(input, init);
		if (!dropped && request.operation.kind === 'events') {
			dropped = true;
			throw new Error('event response lost');
		}
		return response;
	};
	const page = await openPage(context, { fetch: flakyFetch });
	try {
		const notes = page.bind({ notes: notesLens }).notes.notes;
		const changed: string[][] = [];
		notes.subscribe((ids) => changed.push(ids));
		const row = await notes.create({ title: 'Event replay' });
		await eventually(() => expect(changed).toEqual([[row.id]]));
		expect(dropped).toBe(true);
	} finally {
		await dispose(context, page);
	}
});

test('page-local document updates are durable and tombstones revoke every handle', async () => {
	const context = setup();
	const first = await openPage(context);
	const second = await openPage(context);
	try {
		const firstNotes = first.bind({ notes: notesLens }).notes.notes;
		const secondNotes = second.bind({ notes: notesLens }).notes.notes;
		const row = await firstNotes.create({ title: 'Document' });
		const firstDocument = await firstNotes.openDocument(row.id);
		(firstDocument.get('content', 'text') as unknown as TextRoot).insert(
			0,
			'durable text',
		);
		await firstDocument.whenDurable();

		const secondDocument = await secondNotes.openDocument(row.id);
		expect(
			(secondDocument.get('content', 'text') as unknown as TextRoot).toString(),
		).toBe('durable text');
		await secondNotes.delete(row.id);
		await eventually(() => {
			expect(() => firstDocument.get('content', 'text')).toThrow(/deleted/);
			expect(() => secondDocument.get('content', 'text')).toThrow(/deleted/);
		});
		await expect(firstDocument[Symbol.asyncDispose]()).resolves.toBeUndefined();
		await expect(
			secondDocument[Symbol.asyncDispose](),
		).resolves.toBeUndefined();
	} finally {
		await dispose(context, first, second);
	}
});

test('a stale document update is refused and revokes before the next event poll', async () => {
	const context = setup();
	const page = await openPage(context, { pollIntervalMs: 10_000 });
	try {
		const notes = page.bind({ notes: notesLens }).notes.notes;
		const row = await notes.create({ title: 'Race' });
		const document = await notes.openDocument(row.id);
		await notes.delete(row.id);
		(document.get('content', 'text') as unknown as TextRoot).insert(0, 'late');
		await expect(document.whenDurable()).rejects.toThrow(
			'Desktop record operation failed',
		);
		expect(() => document.get('content', 'text')).toThrow(
			'Desktop record operation failed',
		);
		await expect(document[Symbol.asyncDispose]()).rejects.toThrow(
			'Desktop record operation failed',
		);
		expect(
			context.replica.inspectDocument({
				namespace: notesLens.namespace,
				collection: 'notes',
				recordKey: row.id,
			}),
		).toBeNull();
	} finally {
		await dispose(context, page);
	}
});

test('attachment changes and sanitized sync failures remain observable', async () => {
	const context = setup();
	const page = await openPage(context);
	try {
		const attachments: unknown[] = [];
		const statuses: unknown[] = [];
		page.subscribeAttachment((attachment) => attachments.push(attachment));
		page.subscribeSyncStatus((status) => statuses.push(status));
		context.replica.localWrite({
			address: {
				namespace: notesLens.namespace,
				collection: 'notes',
				recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			},
			op: 'replace',
			value: { title: 'Discard me' },
		});
		context.replica.attach(
			{
				deploymentId: 'https://api.example.com/',
				principalId: 'principal-one',
			},
			'discard',
		);
		await eventually(() =>
			expect(attachments.at(-1)).toMatchObject({ kind: 'attached' }),
		);
		expect(page.attachment).toMatchObject({
			kind: 'attached',
			attachment: { principalId: 'principal-one' },
		});

		await context.owner.epicenter.attachSync({
			attachment: {
				deploymentId: 'https://api.example.com/',
				principalId: 'principal-one',
			},
			transport: {
				async readFacts() {
					throw new Error('Bearer desktop-secret must never cross the wire');
				},
				async submit() {
					throw new Error('no scalar work expected');
				},
				async publishDocument() {
					throw new Error('no document work expected');
				},
				async publishBlob() {
					throw new Error('no blob work expected');
				},
			},
		});
		await eventually(() =>
			expect(page.syncStatus.lastError?.message).toBe(
				'Desktop record synchronization failed',
			),
		);
		expect(JSON.stringify(statuses)).not.toContain('desktop-secret');
		expect(page.syncStatus.lastError?.message).toBe(
			'Desktop record synchronization failed',
		);
	} finally {
		await dispose(context, page);
	}
});

test('opening a newer generation fences stale surface mutations', async () => {
	const context = setup();
	try {
		const surfaceId = 'same-surface';
		const first = resultOf(
			await context.owner.execute({
				surfaceId,
				operation: { kind: 'open' },
			}),
		);
		if (first.kind !== 'open') throw new Error('first open result missing');
		const second = resultOf(
			await context.owner.execute({
				surfaceId,
				operation: { kind: 'open' },
			}),
		);
		if (second.kind !== 'open') throw new Error('second open result missing');
		expect(second.generation).toBeGreaterThan(first.generation);
		const stale = await context.owner.execute({
			surfaceId,
			generation: first.generation,
			mutationId: 1,
			operation: {
				kind: 'replace',
				address: {
					namespace: notesLens.namespace,
					collection: 'settings',
					recordKey: 'theme',
				},
				value: 'dark',
			},
		});
		expect(stale.error).toMatchObject({
			name: EPICENTER_DESKTOP_RECORD_MOVED_ERROR_NAME,
		});
		expect(
			context.replica.visible({
				namespace: notesLens.namespace,
				collection: 'settings',
				recordKey: 'theme',
			}),
		).toBeNull();
	} finally {
		await context.owner[Symbol.asyncDispose]();
		context.database.close();
	}
});

test('a mutation ID replays only its exact operation payload', async () => {
	const context = setup();
	try {
		const surfaceId = 'exact-replay';
		const opened = resultOf(
			await context.owner.execute({
				surfaceId,
				operation: { kind: 'open' },
			}),
		);
		if (opened.kind !== 'open') throw new Error('open result missing');
		const address = {
			namespace: notesLens.namespace,
			collection: 'settings',
			recordKey: 'theme',
		};
		expect(
			resultOf(
				await context.owner.execute({
					surfaceId,
					generation: opened.generation,
					mutationId: 1,
					operation: { kind: 'replace', address, value: 'light' },
				}),
			).kind,
		).toBe('replace');
		const changed = await context.owner.execute({
			surfaceId,
			generation: opened.generation,
			mutationId: 1,
			operation: { kind: 'replace', address, value: 'dark' },
		});
		expect(changed.error).toMatchObject({
			name: 'EpicenterDesktopRecordRequestError',
		});
		expect(context.replica.visible(address)).toMatchObject({
			payload: 'light',
		});
	} finally {
		await context.owner[Symbol.asyncDispose]();
		context.database.close();
	}
});

test('expired surfaces are swept before the bounded owner admits a replacement', async () => {
	let now = 0;
	const context = setup({
		now: () => now,
		surfaceLeaseMs: 10,
		maxSurfaces: 1,
	});
	try {
		expect(
			resultOf(
				await context.owner.execute({
					surfaceId: 'first',
					operation: { kind: 'open' },
				}),
			).kind,
		).toBe('open');
		const full = await context.owner.execute({
			surfaceId: 'second',
			operation: { kind: 'open' },
		});
		expect(full.error).toEqual({
			name: 'EpicenterDesktopRecordOperationError',
			message: 'Desktop record operation failed',
		});
		now = 10;
		expect(
			resultOf(
				await context.owner.execute({
					surfaceId: 'second',
					operation: { kind: 'open' },
				}),
			).kind,
		).toBe('open');
	} finally {
		await context.owner[Symbol.asyncDispose]();
		context.database.close();
	}
});

test('unknown and malformed operations stop at the sanitized owner boundary', async () => {
	const context = setup();
	try {
		for (const input of [
			{ surfaceId: 'surface', operation: { kind: 'unknown', secret: 'token' } },
			{ surfaceId: 'surface', operation: { kind: 'read' } },
			{
				surfaceId: 'surface',
				operation: { kind: 'open', unexpected: true },
			},
		]) {
			expect(await context.owner.execute(input)).toEqual({
				result: null,
				error: {
					name: 'EpicenterDesktopRecordRequestError',
					message: 'Desktop record request is invalid',
				},
			});
		}
	} finally {
		await context.owner[Symbol.asyncDispose]();
		context.database.close();
	}
});

test('disposal bounds an unresponsive event poll before disconnecting the surface', async () => {
	const context = setup();
	let eventPollStarted = false;
	const stalledFetch: Setup['fetch'] = async (input, init) => {
		const request = JSON.parse(String(init?.body)) as DesktopRecordRequest;
		if (request.operation.kind === 'events') {
			eventPollStarted = true;
			return new Promise<Response>(() => undefined);
		}
		return context.fetch(input, init);
	};
	const page = await openPage(context, {
		fetch: stalledFetch,
		pollIntervalMs: 1,
		requestTimeoutMs: 5,
	});
	try {
		await eventually(() => expect(eventPollStarted).toBe(true));
		await expect(page[Symbol.asyncDispose]()).resolves.toBeUndefined();
	} finally {
		await context.owner[Symbol.asyncDispose]();
		context.database.close();
	}
});

function resultOf(response: DesktopRecordResponse) {
	if (response.error !== null) throw new Error(response.error.message);
	return response.result;
}
