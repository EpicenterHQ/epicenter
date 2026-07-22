import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';

import {
	scanPortableArtifactIndex,
	writePortableArtifactIndex,
} from './portable-artifact.js';
import { writeSnapshotArtifact } from './store/replica/snapshot-artifact.js';

function documentUpdate(): Uint8Array {
	const document = new Y.Doc({ gc: true });
	document.get('body').insert(0, 'portable');
	const update = new Uint8Array(Y.encodeStateAsUpdateV2(document));
	document.destroy();
	return update;
}

test('portable artifacts round-trip live and unset records without source identity', () => {
	const raw = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(raw);
	try {
		const metadata = writePortableArtifactIndex({
			database,
			records: [
				{
					address: {
						namespace: 'so.epicenter.notes',
						collection: 'notes',
						recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
					},
					scalar: { state: 'live', payload: { title: 'Portable' } },
					documentUpdateV2: documentUpdate(),
					blobSha256: 'a'.repeat(64),
				},
				{
					address: {
						namespace: 'so.epicenter.notes',
						collection: 'notes',
						recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
					},
					scalar: { state: 'unset' },
					documentUpdateV2: null,
					blobSha256: null,
				},
			],
		});
		expect(metadata).toEqual({
			kind: 'portable',
			formatVersion: 1,
			recordCount: 2,
		});
		const declaration = raw
			.query('SELECT * FROM _epicenter_artifact')
			.get() as Record<string, unknown>;
		expect(declaration).toEqual({
			singleton: 1,
			kind: 'portable',
			format_version: 1,
		});
		expect(Object.keys(declaration)).not.toContain('source_authority_lifetime');

		const entries: unknown[] = [];
		const opened = scanPortableArtifactIndex({
			database,
			onPage: (page) => entries.push(...page),
		});
		expect(opened.recordCount).toBe(2);
		expect(entries).toMatchObject([
			{
				scalar: { state: 'live', payload: { title: 'Portable' } },
				blobSha256: 'a'.repeat(64),
			},
			{ scalar: { state: 'unset' }, blobSha256: null },
		]);
	} finally {
		raw.close();
	}
});

test('portable validation structurally refuses a snapshot artifact', () => {
	const raw = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(raw);
	try {
		writeSnapshotArtifact({
			database,
			sourceAuthorityLifetime: null,
			sourceAuthorityAfterSequence: 0,
			records: [],
		});
		expect(() =>
			scanPortableArtifactIndex({ database, onPage: () => undefined }),
		).toThrow('Portable artifact column shape is not recognized');
	} finally {
		raw.close();
	}
});

test('portable validation refuses lax tables with the expected names', () => {
	const raw = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(raw);
	try {
		raw.run(
			'CREATE TABLE _epicenter_artifact (kind TEXT, format_version INTEGER)',
		);
		raw.run(
			`CREATE TABLE _epicenter_records (
				namespace TEXT, collection TEXT, record_key TEXT, payload_json TEXT,
				document_update_v2 BLOB, blob_sha256 TEXT
			)`,
		);
		raw.run("INSERT INTO _epicenter_artifact VALUES ('portable', 1)");
		raw.run(
			`INSERT INTO _epicenter_records VALUES
			('so.epicenter.notes', 'notes', 'aaaaaaaaaaaaaaaaaaaaaaaa', NULL, NULL, NULL),
			('so.epicenter.notes', 'notes', 'aaaaaaaaaaaaaaaaaaaaaaaa', NULL, NULL, NULL)`,
		);
		expect(() =>
			scanPortableArtifactIndex({ database, onPage: () => undefined }),
		).toThrow('Portable artifact table shape is not recognized');
	} finally {
		raw.close();
	}
});

test('portable validation refuses a dependency-only document update', () => {
	const source = new Y.Doc({ gc: true });
	const body = source.get('body');
	body.insert(0, 'first');
	const first = Y.encodeStateAsUpdateV2(source);
	const stateVector = Y.encodeStateVector(source);
	body.insert(5, ' second');
	const dependent = Y.encodeStateAsUpdateV2(source, stateVector);
	source.destroy();
	expect(first.byteLength).toBeGreaterThan(0);

	const raw = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(raw);
	try {
		expect(() =>
			writePortableArtifactIndex({
				database,
				records: [
					{
						address: {
							namespace: 'so.epicenter.notes',
							collection: 'notes',
							recordKey: 'cccccccccccccccccccccccc',
						},
						scalar: { state: 'unset' },
						documentUpdateV2: dependent,
						blobSha256: null,
					},
				],
			}),
		).toThrow('Portable document update is invalid');
	} finally {
		raw.close();
	}
});
