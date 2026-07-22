import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import type {
	BlobFileStore,
	OwnedBlobFile,
	StagedBlob,
} from './blob-v1/index.js';
import { defineLens, defineTable, defineValues } from './lens.js';
import { sha256HexBytes } from './protocol/v1/canonical.js';
import { makeLimits } from './protocol/v1/kernel.test-support.js';
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
	const blobs = createReplicaBlobStore(adapter, new MemoryBlobFiles());
	const epicenter = createRecordEpicenter({ replica, blobs });
	return {
		database,
		replica,
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
			expect(context.data.notes.notes.blob.inspect(row.id)).toEqual({
				kind: 'pending',
				digest,
			});
			expect(await context.data.notes.notes.blob.get(row.id)).toEqual(bytes);

			await context.data.notes.notes.delete(row.id);
			expect(() => reopened.get('content')).toThrow('no longer live');
			await reopened[Symbol.asyncDispose]();
		} finally {
			await context.epicenter[Symbol.asyncDispose]();
			context.database.close();
		}
	});
});
