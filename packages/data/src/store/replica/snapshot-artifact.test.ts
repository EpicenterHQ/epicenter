import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import { defineLens, defineTable, defineValues } from '../../lens.js';
import { makeLimits } from '../../protocol/v1/kernel.test-support.js';
import { openReplicaStore } from './replica-store.js';

const LIMITS = makeLimits();
const NOTE = {
	namespace: 'so.epicenter.notes',
	collection: 'notes',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

function openSource() {
	const raw = new Database(':memory:', { strict: true });
	const store = openReplicaStore({
		database: createBunSqliteAdapter(raw),
		limits: LIMITS,
		initialize: {
			replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
			authorityLifetime: 'lifetime-one',
		},
	});
	return { raw, store };
}

function inspectionLens() {
	return defineLens({
		namespace: NOTE.namespace,
		title: 'Notes',
		description: 'Notes and settings.',
		collections: {
			notes: defineTable({
				title: 'Notes',
				fields: {
					title: field.string(),
					done: field.boolean(),
					tags: field.tags(),
				},
				optional: ['done', 'tags'],
			}),
			settings: defineValues({
				title: 'Settings',
				values: { theme: field.select(['light', 'dark']) },
			}),
		},
	});
}

describe('inspection snapshot artifacts', () => {
	test('captures visible state and metadata without document or blob bytes', () => {
		const source = openSource();
		const target = new Database(':memory:', { strict: true });
		try {
			source.store.localWrite({
				address: NOTE,
				op: 'replace',
				value: { title: 'First', done: true, tags: ['local'] },
			});
			source.raw.run(
				`UPDATE records SET doc_revision = 2, doc_dirty = 1,
					blob_sha256 = ? WHERE record_key = ?`,
				['a'.repeat(64), NOTE.recordKey],
			);
			source.raw.run(
				`INSERT INTO record_documents (record_id, seq, kind, bytes)
				SELECT record_id, 1, 'baseline', ? FROM records WHERE record_key = ?`,
				[new Uint8Array([1, 2, 3, 4]), NOTE.recordKey],
			);
			const deleted = { ...NOTE, recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb' };
			source.store.localWrite({
				address: deleted,
				op: 'replace',
				value: { title: 'Gone' },
			});
			source.store.localWrite({ address: deleted, op: 'tombstone' });

			const metadata = source.store.captureSnapshot({
				database: createBunSqliteAdapter(target),
			});
			expect(metadata).toMatchObject({
				kind: 'snapshot',
				formatVersion: 1,
				sourceAuthorityLifetime: 'lifetime-one',
				captureWatermark: 0,
				lens: null,
				recordCount: 1,
			});
			expect(
				target
					.query(
						`SELECT namespace, collection, record_key, payload_json,
							document_revision, document_byte_length, document_dirty,
							blob_sha256 FROM _epicenter_records`,
					)
					.get(),
			).toEqual({
				namespace: NOTE.namespace,
				collection: NOTE.collection,
				record_key: NOTE.recordKey,
				payload_json: '{"done":true,"tags":["local"],"title":"First"}',
				document_revision: 2,
				document_byte_length: 4,
				document_dirty: 1,
				blob_sha256: 'a'.repeat(64),
			});
			expect(
				target
					.query(
						'SELECT kind, format_version, source_authority_lifetime, capture_watermark, lens_json FROM _epicenter_artifact',
					)
					.get(),
			).toEqual({
				kind: 'snapshot',
				format_version: 1,
				source_authority_lifetime: 'lifetime-one',
				capture_watermark: 0,
				lens_json: null,
			});
		} finally {
			target.close();
			source.raw.close();
		}
	});

	test('creates guarded table and values views for one selected Lens', () => {
		const source = openSource();
		const target = new Database(':memory:', { strict: true });
		try {
			source.store.localWrite({
				address: NOTE,
				op: 'replace',
				value: { title: 42, done: true, tags: ['one', 'two'] },
			});
			source.store.localWrite({
				address: {
					namespace: NOTE.namespace,
					collection: 'settings',
					recordKey: 'theme',
				},
				op: 'replace',
				value: 'dark',
			});
			const lens = inspectionLens();
			source.store.captureSnapshot({
				database: createBunSqliteAdapter(target),
				lens,
			});
			expect(
				target.query('SELECT id, title, done, tags FROM notes').get(),
			).toEqual({
				id: NOTE.recordKey,
				title: null,
				done: 1,
				tags: '["one","two"]',
			});
			expect(target.query('SELECT theme FROM settings').get()).toEqual({
				theme: 'dark',
			});
			const lensJson = target
				.query<{ lens_json: string }, []>(
					'SELECT lens_json FROM _epicenter_artifact',
				)
				.get()?.lens_json;
			expect(JSON.parse(lensJson ?? '')).toEqual(lens);
		} finally {
			target.close();
			source.raw.close();
		}
	});

	test('refuses SQLite-colliding Lens views before writing the target', () => {
		const source = openSource();
		const target = new Database(':memory:', { strict: true });
		try {
			const definition = () =>
				defineTable({
					title: 'Rows',
					fields: { title: field.string() },
					optional: [],
				});
			const lens = defineLens({
				namespace: NOTE.namespace,
				title: 'Collision',
				description: 'Collision fixture.',
				collections: { Notes: definition(), notes: definition() },
			});
			expect(() =>
				source.store.captureSnapshot({
					database: createBunSqliteAdapter(target),
					lens,
				}),
			).toThrow("Snapshot view names 'Notes' and 'notes' collide in SQLite");
			expect(
				target
					.query("SELECT name FROM sqlite_schema WHERE type = 'table'")
					.all(),
			).toEqual([]);
		} finally {
			target.close();
			source.raw.close();
		}
	});
});
