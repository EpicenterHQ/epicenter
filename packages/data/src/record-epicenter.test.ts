/**
 * Record Owner and Lens Runtime Tests
 *
 * Verifies typed Lens behavior over the owner's local schema-opaque access and
 * the record-owned document and blob capabilities composed by that owner.
 *
 * Key behaviors:
 * - Lens validation and projection stay in the Lens runtime
 * - One owner persists scalar, document, blob, and subscription state
 * - Accepted remote document updates do not create local publication work
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';

import type {
	BlobFileStore,
	OwnedBlobFile,
	StagedBlob,
} from './blob-v1/index.js';
import { defineLens, defineTable, defineValues } from './lens.js';
import { sha256HexBytes } from './protocol/v1/canonical.js';
import { makeLimits } from './protocol/v1/kernel.test-support.js';
import { recordDocumentConnectionTarget } from './record-document-connection.js';
import { createRecordEpicenter } from './record-epicenter.js';
import {
	createReplicaBlobStore,
	openReplicaStore,
} from './store/replica/index.js';

class MemoryBlobFiles implements BlobFileStore<Uint8Array, Uint8Array> {
	readonly staging = new Map<string, Uint8Array>();
	readonly content = new Map<string, Uint8Array>();

	async stage(source: Uint8Array): Promise<StagedBlob> {
		const bytes = new Uint8Array(source);
		const digest = sha256HexBytes(bytes);
		const id = `${digest}-${this.staging.size}`;
		this.staging.set(id, bytes);
		return { id, digest };
	}

	async promote(staged: StagedBlob, owner: OwnedBlobFile): Promise<void> {
		const bytes = this.staging.get(staged.id);
		if (bytes === undefined) throw new Error('staged bytes missing');
		this.content.set(this.key(owner), bytes);
		this.staging.delete(staged.id);
	}

	async open(owner: OwnedBlobFile): Promise<Uint8Array> {
		const bytes = this.content.get(this.key(owner));
		if (bytes === undefined) throw new Error('blob bytes missing');
		return new Uint8Array(bytes);
	}

	async sweepStaging(): Promise<void> {
		this.staging.clear();
	}

	async sweepContent(owned: readonly OwnedBlobFile[]): Promise<void> {
		const retained = new Set(owned.map((owner) => this.key(owner)));
		for (const key of this.content.keys()) {
			if (!retained.has(key)) this.content.delete(key);
		}
	}

	private key(owner: OwnedBlobFile): string {
		return `${owner.ownerKey}/${owner.digest}`;
	}
}

const notesLens = defineLens({
	namespace: 'so.epicenter.notes',
	title: 'Notes',
	description: 'Notes and preferences.',
	collections: {
		notes: defineTable({
			title: 'Notes',
			fields: {
				title: field.string(),
				note: field.string(),
			},
			optional: ['note'],
		}),
		settings: defineValues({
			title: 'Settings',
			values: { theme: field.select(['light', 'dark']) },
		}),
	},
});

const ATTACHMENT = {
	deploymentId: 'https://api.example.com/',
	principalId: 'principal-one',
} as const;

function setup() {
	const database = new Database(':memory:', { strict: true });
	const adapter = createBunSqliteAdapter(database);
	const replica = openReplicaStore({
		database: adapter,
		limits: makeLimits(),
		initialize: {
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			authorityLifetime: 'lifetime-one',
		},
	});
	const files = new MemoryBlobFiles();
	const blobs = createReplicaBlobStore(adapter, files);
	const epicenter = createRecordEpicenter({ replica, blobs });
	return {
		database,
		replica,
		files,
		epicenter,
		data: epicenter.bind({ notes: notesLens }),
	};
}

describe('record Epicenter Lens runtime', () => {
	test('binds table CRUD, classified traversal, values, and subscriptions', async () => {
		const context = setup();
		try {
			const changed: string[][] = [];
			context.data.notes.notes.subscribe((ids) => changed.push(ids));
			const invalid: unknown = { title: 42 };
			await expect(
				context.data.notes.notes.create(invalid as never),
			).rejects.toThrow();
			expect(
				context.replica.visibleRecords(notesLens.namespace, 'notes').entries,
			).toEqual([]);

			const row = await context.data.notes.notes.create({ title: 'First' });
			expect(await context.data.notes.notes.get(row.id)).toMatchObject({
				data: { id: row.id, title: 'First' },
				error: null,
			});

			context.replica.localWrite({
				address: {
					namespace: notesLens.namespace,
					collection: 'notes',
					recordKey: row.id,
				},
				op: 'patch',
				set: { unknown: true },
				unset: [],
			});
			await context.data.notes.notes.update(row.id, { note: 'Remember' });
			expect(await context.data.notes.notes.get(row.id)).toMatchObject({
				data: { id: row.id, title: 'First', note: 'Remember' },
			});
			expect(
				context.replica.visible({
					namespace: notesLens.namespace,
					collection: 'notes',
					recordKey: row.id,
				}),
			).toMatchObject({ payload: { unknown: true } });

			const malformedId = 'b'.repeat(24);
			context.replica.localWrite({
				address: {
					namespace: notesLens.namespace,
					collection: 'notes',
					recordKey: malformedId,
				},
				op: 'replace',
				value: 'scalar',
			});
			const scan = await context.data.notes.notes.scan();
			expect(scan.rows).toEqual([
				{ id: row.id, title: 'First', note: 'Remember' },
			]);
			expect(scan.nonconforming).toHaveLength(1);
			expect(scan.nonconforming[0]?.raw).toBe('scalar');

			let valueChanges = 0;
			context.data.notes.settings.theme.subscribe(() => (valueChanges += 1));
			await context.data.notes.settings.theme.set('dark');
			expect(await context.data.notes.settings.theme.get()).toMatchObject({
				data: 'dark',
			});
			await context.data.notes.settings.theme.unset();
			expect(await context.data.notes.settings.theme.get()).toMatchObject({
				data: undefined,
			});
			expect(valueChanges).toBe(2);
			expect(changed.flat()).toContain(row.id);
		} finally {
			await context.epicenter[Symbol.asyncDispose]();
			context.database.close();
		}
	});

	test('one bind refuses contradictory collection kinds', async () => {
		const context = setup();
		try {
			const table = defineLens({
				namespace: 'so.epicenter.collision',
				title: 'Table',
				description: 'Table interpretation.',
				collections: {
					shared: defineTable({
						title: 'Shared',
						fields: { title: field.string() },
						optional: [],
					}),
				},
			});
			const values = defineLens({
				namespace: 'so.epicenter.collision',
				title: 'Values',
				description: 'Values interpretation.',
				collections: {
					shared: defineValues({
						title: 'Shared',
						values: { title: field.string() },
					}),
				},
			});
			expect(() => context.epicenter.bind({ table, values })).toThrow(
				"cannot be both 'table' and 'values'",
			);
		} finally {
			await context.epicenter[Symbol.asyncDispose]();
			context.database.close();
		}
	});

	test('owns record documents and immutable blob bytes under table rows', async () => {
		const context = setup();
		try {
			const row = await context.data.notes.notes.create({ title: 'Media' });
			const first = await context.data.notes.notes.openDocument(row.id);
			first.get('content').insert(0, 'hello');
			await first.whenDurable();
			await first[Symbol.asyncDispose]();
			const reopened = await context.data.notes.notes.openDocument(row.id);
			expect(reopened.get('content').toString()).toBe('hello');

			const bytes = new TextEncoder().encode('audio');
			const digest = await context.data.notes.notes.blob.put(row.id, bytes);
			expect(await context.data.notes.notes.blob.inspect(row.id)).toEqual({
				kind: 'owed',
				digest,
			});
			expect(await context.data.notes.notes.blob.get(row.id)).toEqual(bytes);
			expect(context.replica.workSummary()).toMatchObject({
				document: { owed: 1, parked: 0 },
				blob: { owed: 1, parked: 0 },
			});
			expect(context.replica.owedDocuments()).toEqual([
				{
					namespace: notesLens.namespace,
					collection: 'notes',
					recordKey: row.id,
				},
			]);
			expect(context.replica.owedBlobs()).toEqual([
				{
					namespace: notesLens.namespace,
					collection: 'notes',
					recordKey: row.id,
				},
			]);

			const address = {
				namespace: notesLens.namespace,
				collection: 'notes',
				recordKey: row.id,
			};
			context.replica.localWrite({ address, op: 'unset' });
			expect(reopened.get('content').toString()).toBe('hello');
			expect(context.replica.inspectDocument(address)).not.toBeNull();
			context.replica.localWrite({
				address,
				op: 'replace',
				value: { title: 'Media again' },
			});

			await context.data.notes.notes.delete(row.id);
			expect(() => reopened.get('content')).toThrow('no longer live');
			await reopened[Symbol.asyncDispose]();
		} finally {
			await context.epicenter[Symbol.asyncDispose]();
			context.database.close();
		}
	});

	test('discarding the first local replica revokes its open documents', async () => {
		const context = setup();
		try {
			const row = await context.data.notes.notes.create({
				title: 'Discard me',
			});
			const document = await context.data.notes.notes.openDocument(row.id);
			document.get('content').insert(0, 'local only');

			expect(context.replica.attach(ATTACHMENT, 'discard')).toEqual({
				attached: true,
				discarded: true,
			});
			expect(() => document.get('content')).toThrow('no longer live');
			await document[Symbol.asyncDispose]();
		} finally {
			await context.epicenter[Symbol.asyncDispose]();
			context.database.close();
		}
	});

	test('creates a live row and its blob as one Lens operation', async () => {
		const context = setup();
		try {
			const changed: string[][] = [];
			context.data.notes.notes.subscribe((ids) => changed.push(ids));
			await expect(
				context.data.notes.notes.createWithBlob(
					{ title: 42 } as never,
					new TextEncoder().encode('must not be staged'),
				),
			).rejects.toThrow();
			expect(context.files.staging.size).toBe(0);
			expect(context.files.content.size).toBe(0);
			const bytes = new TextEncoder().encode('atomic audio');
			const row = await context.data.notes.notes.createWithBlob(
				{ title: 'Atomic media' },
				bytes,
			);

			expect(await context.data.notes.notes.get(row.id)).toMatchObject({
				data: { id: row.id, title: 'Atomic media' },
				error: null,
			});
			expect(await context.data.notes.notes.blob.get(row.id)).toEqual(bytes);
			expect(await context.data.notes.notes.blob.inspect(row.id)).toMatchObject(
				{
					kind: 'owed',
				},
			);
			expect(changed).toEqual([[row.id]]);
		} finally {
			await context.epicenter[Symbol.asyncDispose]();
			context.database.close();
		}
	});

	test('publishes the committed first attachment', async () => {
		const context = setup();
		try {
			const attachments: unknown[] = [];
			context.epicenter.subscribeAttachment((attachment) =>
				attachments.push(attachment),
			);
			await context.epicenter.attachSync({
				attachment: ATTACHMENT,
				transport: {
					async readFacts() {
						return {
							authorityLifetime: 'lifetime-one',
							facts: [],
							hasMore: false,
						};
					},
					async submit() {
						throw new Error('unexpected scalar submission');
					},
					async publishDocument() {
						throw new Error('unexpected document publication');
					},
					async publishBlob() {
						throw new Error('unexpected blob publication');
					},
				},
			});
			expect(attachments).toEqual([
				{ kind: 'attached', attachment: ATTACHMENT },
			]);
			expect(context.epicenter.syncStatus.authorityLifetime).toBe(
				'lifetime-one',
			);
		} finally {
			await context.epicenter[Symbol.asyncDispose]();
			context.database.close();
		}
	});

	test('accepted remote document updates stay outside local publication work', async () => {
		const context = setup();
		try {
			const row = await context.data.notes.notes.create({ title: 'Shared' });
			const document = await context.data.notes.notes.openDocument(row.id);
			const remote = new Y.Doc({ gc: true });
			remote.get('content').insert(0, 'from authority');
			const accepted = new Uint8Array(Y.encodeStateAsUpdateV2(remote));

			recordDocumentConnectionTarget(document).applyUpdate(
				accepted,
				'authority',
			);

			expect(document.get('content').toString()).toBe('from authority');
			expect(
				context.replica.inspectDocument({
					namespace: notesLens.namespace,
					collection: 'notes',
					recordKey: row.id,
				}),
			).toMatchObject({ owed: false });
			expect(context.replica.workSummary().document.owed).toBe(0);

			remote.destroy();
			await document[Symbol.asyncDispose]();
		} finally {
			await context.epicenter[Symbol.asyncDispose]();
			context.database.close();
		}
	});

	test('separate Lens bindings borrow one owner without gaining its lifecycle', async () => {
		const context = setup();
		try {
			const first = context.epicenter.bind({ first: notesLens });
			const second = context.epicenter.bind({ second: notesLens });
			expect(Symbol.asyncDispose in first).toBe(false);
			expect(Symbol.asyncDispose in second).toBe(false);

			const row = await first.first.notes.create({ title: 'Borrowed' });
			const document = await first.first.notes.openDocument(row.id);
			document.get('content').insert(0, 'temporary handle');
			await document[Symbol.asyncDispose]();

			await second.second.notes.update(row.id, { note: 'Still open' });
			expect(await first.first.notes.get(row.id)).toMatchObject({
				data: { id: row.id, title: 'Borrowed', note: 'Still open' },
			});
		} finally {
			await context.epicenter[Symbol.asyncDispose]();
			context.database.close();
		}
	});

	test('disposed owners refuse status reads and bound operations', async () => {
		const context = setup();
		await context.epicenter[Symbol.asyncDispose]();

		expect(() => context.epicenter.attachment).toThrow('disposed');
		expect(() => context.epicenter.syncStatus).toThrow('disposed');
		await expect(context.data.notes.notes.scan()).rejects.toThrow('disposed');

		context.database.close();
	});
});
