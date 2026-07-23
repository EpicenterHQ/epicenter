/**
 * Production replica-store opening and format-recognition tests.
 *
 * The conformance suite owns lane semantics and crash atomicity. These cases
 * protect the clean-break boundary around the dedicated SQLite file itself:
 * initialization occurs only in an empty database, and reopening recognizes
 * exactly the format-three tables and indexes owned by this store. Visible-read
 * cases verify tombstone-first lane derivation and bytewise keyset paging.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { SqliteDatabase } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';

import type {
	Fact,
	JsonValue,
	RecordAddress,
} from '../../protocol/v1/index.js';
import { makeLimits } from '../../protocol/v1/kernel.test-support.js';
import {
	openReplicaStore,
	PUBLICATION_OBLIGATION_PAGE_LIMIT,
	REPLICA_STORE_INDEXES,
	REPLICA_STORE_TABLES,
	type ReplicaStore,
} from './index.js';

const LIMITS = makeLimits();
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const NAMESPACE = 'so.epicenter.notes';
const COLLECTION = 'recordings';
const ATTACHMENT = {
	deploymentId: 'https://example.test/',
	principalId: 'principal-a',
} as const;

type FactInput =
	| { address: RecordAddress; state: 'live'; payload: JsonValue }
	| { address: RecordAddress; state: 'tombstone' | 'unset' };

function address(recordKey: string): RecordAddress {
	return { namespace: NAMESPACE, collection: COLLECTION, recordKey };
}

function setup() {
	const database = new Database(':memory:', { strict: true });
	const store = openReplicaStore({
		database: createBunSqliteAdapter(database),
		limits: LIMITS,
		initialize: {
			replicaId: REPLICA_ID,
			authorityLifetime: 'lifetime-one',
		},
	});
	return { database, store };
}

function installFacts(store: ReplicaStore, inputs: readonly FactInput[]): void {
	const afterSequence = store.sync().afterSequence;
	const facts: Fact[] = inputs.map((input, index) => ({
		...input,
		sequence: afterSequence + index + 1,
	}));
	store.installFacts({
		request: { authorityLifetime: 'lifetime-one', afterSequence },
		response: {
			authorityLifetime: 'lifetime-one',
			facts,
			hasMore: false,
		},
	});
}

function documentUpdate(value: string): Uint8Array {
	const document = new Y.Doc({ gc: true });
	try {
		document.get('content').insert(0, value);
		return new Uint8Array(Y.encodeStateAsUpdateV2(document));
	} finally {
		document.destroy();
	}
}

function userSchemaObjects(database: Database): string[] {
	return database
		.query<{ name: string; type: string }, []>(
			`SELECT type, name FROM sqlite_schema
			WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
			ORDER BY type, name`,
		)
		.all()
		.map(({ type, name }) => `${type}:${name}`);
}

describe('first attachment', () => {
	test('empty replica attaches directly and reopening preserves the pair', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const adapter = createBunSqliteAdapter(database);
			const store = openReplicaStore({
				database: adapter,
				limits: LIMITS,
				initialize: { replicaId: REPLICA_ID },
			});

			expect(store.isLogicallyEmpty()).toBe(true);
			store.attach(ATTACHMENT);
			expect(store.attachment()).toEqual(ATTACHMENT);
			expect(
				openReplicaStore({ database: adapter, limits: LIMITS }).attachment(),
			).toEqual(ATTACHMENT);
			expect(() =>
				openReplicaStore({
					database: adapter,
					limits: LIMITS,
				}).attach({ ...ATTACHMENT, choice: 'discard' }),
			).not.toThrow();
		} finally {
			database.close();
		}
	});

	test('empty replica rejects a dishonest bring or discard choice', () => {
		const { database, store } = setup();
		try {
			expect(() => store.attach({ ...ATTACHMENT, choice: 'bring' })).toThrow(
				/empty replica attaches without a choice/,
			);
			expect(store.attachment()).toBeNull();
		} finally {
			database.close();
		}
	});

	test('nonempty replica without a choice throws without changing state', () => {
		const { database, store } = setup();
		try {
			const target = address('aaaaaaaaaaaaaaaaaaaaaaaa');
			store.localWrite({ address: target, op: 'replace', value: 'pending' });

			expect(() => store.attach(ATTACHMENT)).toThrow(
				/nonempty replica requires bring or discard/,
			);
			expect(store.attachment()).toBeNull();
			expect(store.record(target)?.pending).toEqual({
				op: 'replace',
				value: 'pending',
			});
		} finally {
			database.close();
		}
	});

	test('bring preserves pending scalar, document, and blob obligations', () => {
		const { database, store } = setup();
		try {
			const target = address('aaaaaaaaaaaaaaaaaaaaaaaa');
			const digest = 'a'.repeat(64);
			store.localWrite({ address: target, op: 'replace', value: 'pending' });
			store.appendLocalDocumentUpdate(target, documentUpdate('local'));
			database.run('UPDATE records SET blob_sha256 = ? WHERE record_key = ?', [
				digest,
				target.recordKey,
			]);

			store.attach({ ...ATTACHMENT, choice: 'bring' });

			expect(store.attachment()).toEqual(ATTACHMENT);
			expect(store.record(target)?.pending).toEqual({
				op: 'replace',
				value: 'pending',
			});
			expect(store.inspectDocument(target)).toMatchObject({
				revision: 1,
				acceptedRevision: 0,
				owed: true,
			});
			expect(store.owedBlobs(1)).toEqual([target]);
			expect(
				database
					.query<{ blob_sha256: string }, [string]>(
						'SELECT blob_sha256 FROM records WHERE record_key = ?',
					)
					.get(target.recordKey)?.blob_sha256,
			).toBe(digest);
		} finally {
			database.close();
		}
	});

	test('discard atomically clears logical state and synchronization progress', () => {
		const { database, store } = setup();
		try {
			const target = address('aaaaaaaaaaaaaaaaaaaaaaaa');
			installFacts(store, [
				{ address: target, state: 'live', payload: { remote: true } },
			]);
			store.localWrite({ address: target, op: 'replace', value: 'pending' });
			store.appendLocalDocumentUpdate(target, documentUpdate('local'));
			database.run('UPDATE records SET blob_sha256 = ? WHERE record_key = ?', [
				'b'.repeat(64),
				target.recordKey,
			]);
			store.seal();

			store.attach({ ...ATTACHMENT, choice: 'discard' });

			expect(store.attachment()).toEqual(ATTACHMENT);
			expect(store.isLogicallyEmpty()).toBe(true);
			expect(store.sync()).toMatchObject({
				authorityLifetime: null,
				afterSequence: 0,
				sealedSubmission: null,
				nextSubmission: 1,
			});
			expect(store.sealedRequest()).toBeNull();
			expect(
				database
					.query<{ count: number }, []>(
						'SELECT count(*) AS count FROM record_documents',
					)
					.get()?.count,
			).toBe(0);
			store.localWrite({
				address: address('bbbbbbbbbbbbbbbbbbbbbbbb'),
				op: 'replace',
				value: 'fresh',
			});
			expect(store.isLogicallyEmpty()).toBe(false);
		} finally {
			database.close();
		}
	});

	test('same-pair reattachment is idempotent and another pair is refused', () => {
		const { database, store } = setup();
		try {
			store.attach(ATTACHMENT);
			expect(() =>
				store.attach({ ...ATTACHMENT, choice: 'discard' }),
			).not.toThrow();
			expect(() =>
				store.attach({
					deploymentId: ATTACHMENT.deploymentId,
					principalId: 'principal-b',
				}),
			).toThrow(/permanently attached to another principal/);
			expect(store.attachment()).toEqual(ATTACHMENT);
		} finally {
			database.close();
		}
	});

	test('a local tombstone alone makes the replica nonempty', () => {
		const { database, store } = setup();
		try {
			store.localWrite({
				address: address('aaaaaaaaaaaaaaaaaaaaaaaa'),
				op: 'tombstone',
			});
			expect(store.isLogicallyEmpty()).toBe(false);
			expect(() => store.attach(ATTACHMENT)).toThrow(
				/nonempty replica requires bring or discard/,
			);
		} finally {
			database.close();
		}
	});

	test('a thrown discard exposes the intact unattached replica', () => {
		const database = new Database(':memory:', { strict: true });
		const base = createBunSqliteAdapter(database);
		let failAttachmentWrite = false;
		const faulting: SqliteDatabase = {
			run(sql, parameters) {
				if (failAttachmentWrite && sql.includes('attached_deployment = ?')) {
					throw new Error('injected attachment write failure');
				}
				base.run(sql, parameters);
			},
			all: base.all,
			transaction: base.transaction,
		};
		try {
			const store = openReplicaStore({
				database: faulting,
				limits: LIMITS,
				initialize: {
					replicaId: REPLICA_ID,
					authorityLifetime: 'lifetime-one',
				},
			});
			const target = address('aaaaaaaaaaaaaaaaaaaaaaaa');
			store.localWrite({ address: target, op: 'replace', value: 'pending' });
			store.appendLocalDocumentUpdate(target, documentUpdate('local'));
			failAttachmentWrite = true;

			expect(() => store.attach({ ...ATTACHMENT, choice: 'discard' })).toThrow(
				/injected attachment write failure/,
			);
			expect(store.attachment()).toBeNull();
			expect(store.record(target)?.pending).not.toBeNull();
			expect(store.inspectDocument(target)).toMatchObject({ revision: 1 });
		} finally {
			database.close();
		}
	});
});

describe('production replica store format', () => {
	test('initializes an empty database and reopens only the exact owned schema', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const adapter = createBunSqliteAdapter(database);
			const created = openReplicaStore({
				database: adapter,
				limits: LIMITS,
				initialize: {
					replicaId: REPLICA_ID,
					authorityLifetime: 'lifetime-one',
				},
			});
			expect(created.sync().replicaId).toBe(REPLICA_ID);
			expect(userSchemaObjects(database)).toEqual(
				[
					...REPLICA_STORE_INDEXES.map((name) => `index:${name}`),
					...REPLICA_STORE_TABLES.map((name) => `table:${name}`),
				].sort(),
			);
			expect(
				openReplicaStore({ database: adapter, limits: LIMITS }).sync(),
			).toEqual(created.sync());
		} finally {
			database.close();
		}
	});

	test('refuses to initialize beside an unrelated schema', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			database.exec(
				'CREATE TABLE legacy_workspace (id INTEGER PRIMARY KEY) STRICT',
			);
			expect(() =>
				openReplicaStore({
					database: createBunSqliteAdapter(database),
					limits: LIMITS,
					initialize: { replicaId: REPLICA_ID },
				}),
			).toThrow(/does not match format 3/);
			expect(userSchemaObjects(database)).toEqual(['table:legacy_workspace']);
		} finally {
			database.close();
		}
	});

	test('refuses an incomplete format-three schema', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const adapter = createBunSqliteAdapter(database);
			openReplicaStore({
				database: adapter,
				limits: LIMITS,
				initialize: { replicaId: REPLICA_ID },
			});
			database.exec('DROP INDEX records_pending');
			expect(() =>
				openReplicaStore({ database: adapter, limits: LIMITS }),
			).toThrow(/does not match format 3/);
		} finally {
			database.close();
		}
	});

	test('rejects invalid initial synchronization metadata without creating tables', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			expect(() =>
				openReplicaStore({
					database: createBunSqliteAdapter(database),
					limits: LIMITS,
					initialize: {
						replicaId: REPLICA_ID,
						authorityLifetime: 'x'.repeat(LIMITS.maxLifetimeBytes + 1),
					},
				}),
			).toThrow(/replica initialization failed/);
			expect(userSchemaObjects(database)).toEqual([]);
		} finally {
			database.close();
		}
	});

	test('enforces the bounded document-chain and watermark row shapes', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const store = openReplicaStore({
				database: createBunSqliteAdapter(database),
				limits: LIMITS,
				initialize: { replicaId: REPLICA_ID },
			});
			const address = {
				namespace: 'so.epicenter.notes',
				collection: 'recordings',
				recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			};
			store.localWrite({ address, op: 'replace', value: {} });
			const recordId = database
				.query<{ record_id: number }, []>('SELECT record_id FROM records')
				.get()?.record_id;
			if (recordId === undefined) throw new Error('record was not created');

			expect(() =>
				database.run(
					`INSERT INTO record_documents (record_id, seq, kind, bytes)
					VALUES (?, 2, 'baseline', X'01')`,
					[recordId],
				),
			).toThrow(/constraint failed/);
			// The accepted watermark can never run ahead of the local revision.
			expect(() =>
				database.run(
					`UPDATE records SET document_accepted_revision = 1
					WHERE record_id = ?`,
					[recordId],
				),
			).toThrow(/constraint failed/);
			// Refusal evidence binds the current revision with full measurements.
			expect(() =>
				database.run(
					`UPDATE records SET document_refused_revision = 0,
						document_refused_code = 'document-bound',
						document_refused_bytes = NULL, document_refused_structs = NULL
					WHERE record_id = ?`,
					[recordId],
				),
			).toThrow(/constraint failed/);
		} finally {
			database.close();
		}
	});

	test('bounded drain scans skip blocked work and reject unbounded pages', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const store = openReplicaStore({
				database: createBunSqliteAdapter(database),
				limits: LIMITS,
				initialize: {
					replicaId: REPLICA_ID,
					authorityLifetime: 'lifetime-one',
				},
			});
			const blocked = {
				namespace: 'so.epicenter.notes',
				collection: 'records',
				recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			};
			const ready = { ...blocked, recordKey: 'zzzzzzzzzzzzzzzzzzzzzzzz' };
			store.localWrite({ address: blocked, op: 'replace', value: {} });
			store.localWrite({ address: ready, op: 'replace', value: {} });
			database.run(
				`UPDATE records SET
					document_revision = 1,
					document_refused_revision = CASE WHEN record_key = ? THEN 1 END,
					document_refused_code =
						CASE WHEN record_key = ? THEN 'document-bound' END,
					document_refused_bytes = CASE WHEN record_key = ? THEN 1048577 END,
					document_refused_structs = CASE WHEN record_key = ? THEN 1 END,
					blob_sha256 = ?,
					blob_parked_code = CASE WHEN record_key = ? THEN 'blob-conflict' END`,
				[
					blocked.recordKey,
					blocked.recordKey,
					blocked.recordKey,
					blocked.recordKey,
					'a'.repeat(64),
					blocked.recordKey,
				],
			);

			expect(store.owedDocuments(1)).toEqual([ready]);
			expect(store.owedBlobs(1)).toEqual([ready]);
			expect(() =>
				store.owedDocuments(PUBLICATION_OBLIGATION_PAGE_LIMIT + 1),
			).toThrow(/between 1 and 64/);
		} finally {
			database.close();
		}
	});

	test('retains one internal exhaustion sentinel but never seals it onto the wire', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const store = openReplicaStore({
				database: createBunSqliteAdapter(database),
				limits: LIMITS,
				initialize: {
					replicaId: REPLICA_ID,
					authorityLifetime: 'lifetime-one',
				},
			});
			database.exec(
				'UPDATE meta SET next_submission = 9007199254740992 WHERE singleton = 1',
			);
			store.localWrite({
				address: {
					namespace: 'so.epicenter.notes',
					collection: 'recordings',
					recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
				},
				op: 'replace',
				value: 'pending',
			});
			expect(() => store.seal()).toThrow(/number space is exhausted/);
			expect(() =>
				database.exec(
					'UPDATE meta SET next_submission = 9007199254740993 WHERE singleton = 1',
				),
			).toThrow(/constraint failed/);
		} finally {
			database.close();
		}
	});

	test('shrinks the sealed prefix until its canonical request fits the byte ceiling', () => {
		const database = new Database(':memory:', { strict: true });
		try {
			const store = openReplicaStore({
				database: createBunSqliteAdapter(database),
				limits: makeLimits({ maxSubmissionBytes: 700 }),
				initialize: {
					replicaId: REPLICA_ID,
					authorityLifetime: 'lifetime-one',
				},
			});
			const firstAddress = {
				namespace: 'so.epicenter.notes',
				collection: 'recordings',
				recordKey: 'a'.repeat(24),
			};
			const secondAddress = {
				...firstAddress,
				recordKey: 'b'.repeat(24),
			};
			const addresses = [firstAddress, secondAddress] as const;
			for (const address of addresses) {
				store.localWrite({
					address,
					op: 'replace',
					value: 'x'.repeat(300),
				});
			}
			const sealed = JSON.parse(store.seal().bytes) as {
				intents: { address: (typeof addresses)[number] }[];
			};
			expect(sealed.intents.map((intent) => intent.address)).toEqual([
				firstAddress,
			]);
			expect(store.record(firstAddress)?.sealed).not.toBeNull();
			expect(store.record(secondAddress)?.pending).not.toBeNull();
		} finally {
			database.close();
		}
	});
});

describe('visible record reads', () => {
	test('confirmed tombstone hides a leftover sealed patch', () => {
		const { database, store } = setup();
		try {
			const target = address('aaaaaaaaaaaaaaaaaaaaaaaa');
			installFacts(store, [
				{ address: target, state: 'live', payload: { title: 'remote' } },
			]);
			store.localWrite({
				address: target,
				op: 'patch',
				set: { title: 'local' },
				unset: [],
			});
			store.seal();
			installFacts(store, [{ address: target, state: 'tombstone' }]);

			expect(store.record(target)?.sealed?.op).toBe('patch');
			expect(store.visibleRecord(target)).toEqual({ state: 'absent' });
			expect(store.isVisiblyLive(target)).toBe(false);
		} finally {
			database.close();
		}
	});

	test('pending tombstone and unset operations hide confirmed live records', () => {
		const { database, store } = setup();
		try {
			const tombstoned = address('aaaaaaaaaaaaaaaaaaaaaaaa');
			const unset = address('bbbbbbbbbbbbbbbbbbbbbbbb');
			const confirmedUnset = address('cccccccccccccccccccccccc');
			installFacts(store, [
				{ address: tombstoned, state: 'live', payload: { value: 1 } },
				{ address: unset, state: 'live', payload: { value: 2 } },
				{ address: confirmedUnset, state: 'unset' },
			]);

			store.localWrite({ address: tombstoned, op: 'tombstone' });
			store.localWrite({ address: unset, op: 'unset' });

			expect(store.visibleRecord(tombstoned)).toEqual({ state: 'absent' });
			expect(store.visibleRecord(unset)).toEqual({ state: 'absent' });
			expect(store.visibleRecord(confirmedUnset)).toEqual({ state: 'absent' });
			expect(store.isVisiblyLive(tombstoned)).toBe(false);
			expect(store.isVisiblyLive(unset)).toBe(false);
		} finally {
			database.close();
		}
	});

	test('sealed and pending patches fold in order over confirmed live payload', () => {
		const { database, store } = setup();
		try {
			const target = address('aaaaaaaaaaaaaaaaaaaaaaaa');
			installFacts(store, [
				{
					address: target,
					state: 'live',
					payload: { keep: true, remove: 'confirmed' },
				},
			]);
			store.localWrite({
				address: target,
				op: 'patch',
				set: { sealed: 1 },
				unset: ['remove'],
			});
			store.seal();

			expect(store.visibleRecord(target)).toEqual({
				state: 'live',
				payload: { keep: true, sealed: 1 },
			});

			store.localWrite({
				address: target,
				op: 'patch',
				set: { pending: 2, sealed: 3 },
				unset: [],
			});
			expect(store.visibleRecord(target)).toEqual({
				state: 'live',
				payload: { keep: true, sealed: 3, pending: 2 },
			});
			expect(store.isVisiblyLive(target)).toBe(true);
		} finally {
			database.close();
		}
	});

	test('pending replace substitutes for the confirmed live payload', () => {
		const { database, store } = setup();
		try {
			const target = address('aaaaaaaaaaaaaaaaaaaaaaaa');
			installFacts(store, [
				{ address: target, state: 'live', payload: { old: true } },
			]);
			store.localWrite({
				address: target,
				op: 'replace',
				value: ['replacement'],
			});

			expect(store.visibleRecord(target)).toEqual({
				state: 'live',
				payload: ['replacement'],
			});
		} finally {
			database.close();
		}
	});

	test('an unfoldable patch overlay leaves the confirmed base visible', () => {
		// A patch over a confirmed live non-object payload is schema-valid,
		// reachable state (a values-style replace beneath a table-style patch).
		// The authority will park it as patch-base-not-object (ADR-0163); the
		// optimistic visible state is the unchanged base, never a thrown read.
		const { database, store } = setup();
		try {
			const target = address('aaaaaaaaaaaaaaaaaaaaaaaa');
			installFacts(store, [
				{ address: target, state: 'live', payload: 'plain-string' },
			]);
			store.localWrite({
				address: target,
				op: 'patch',
				set: { field: 1 },
				unset: [],
			});

			expect(store.visibleRecord(target)).toEqual({
				state: 'live',
				payload: 'plain-string',
			});
			expect(store.isVisiblyLive(target)).toBe(true);
			expect(
				store.visibleRecordsPage(NAMESPACE, COLLECTION, null, 10).records,
			).toContainEqual({
				recordKey: target.recordKey,
				payload: 'plain-string',
			});
		} finally {
			database.close();
		}
	});

	test('parked operations do not create or overlay visible state', () => {
		const { database, store } = setup();
		try {
			const absent = address('aaaaaaaaaaaaaaaaaaaaaaaa');
			const live = address('bbbbbbbbbbbbbbbbbbbbbbbb');
			store.localWrite({
				address: absent,
				op: 'patch',
				set: { parked: true },
				unset: [],
			});
			installFacts(store, [
				{ address: live, state: 'live', payload: { confirmed: true } },
			]);
			store.localWrite({
				address: live,
				op: 'patch',
				set: { parked: true },
				unset: [],
			});
			database.run(
				`UPDATE records SET
					parked_op = pending_op,
					parked_args = pending_args,
					parked_code = 'patch-base-not-object',
					pending_op = NULL,
					pending_args = NULL`,
			);

			expect(store.visibleRecord(absent)).toEqual({ state: 'absent' });
			expect(store.visibleRecord(live)).toEqual({
				state: 'live',
				payload: { confirmed: true },
			});
		} finally {
			database.close();
		}
	});

	test('missing addresses are not visibly live', () => {
		const { database, store } = setup();
		try {
			const missing = address('aaaaaaaaaaaaaaaaaaaaaaaa');
			expect(store.visibleRecord(missing)).toEqual({ state: 'absent' });
			expect(store.isVisiblyLive(missing)).toBe(false);
		} finally {
			database.close();
		}
	});
});

describe('visible record paging', () => {
	test('pages live records bytewise and looks past hidden overlays for hasMore', () => {
		const { database, store } = setup();
		try {
			const keys = ['Alpha', 'a', 'b', 'c', 'z'];
			installFacts(
				store,
				keys.map((recordKey) => ({
					address: address(recordKey),
					state: 'live' as const,
					payload: { recordKey },
				})),
			);
			store.localWrite({ address: address('a'), op: 'tombstone' });
			store.localWrite({ address: address('c'), op: 'unset' });

			expect(store.visibleRecordsPage(NAMESPACE, COLLECTION, null, 2)).toEqual({
				records: [
					{ recordKey: 'Alpha', payload: { recordKey: 'Alpha' } },
					{ recordKey: 'b', payload: { recordKey: 'b' } },
				],
				hasMore: true,
			});
			expect(
				store.visibleRecordsPage(NAMESPACE, COLLECTION, 'Alpha', 2),
			).toEqual({
				records: [
					{ recordKey: 'b', payload: { recordKey: 'b' } },
					{ recordKey: 'z', payload: { recordKey: 'z' } },
				],
				hasMore: false,
			});
			expect(store.visibleRecordsPage(NAMESPACE, COLLECTION, 'z', 2)).toEqual({
				records: [],
				hasMore: false,
			});
		} finally {
			database.close();
		}
	});

	test('rejects non-positive and fractional page limits', () => {
		const { database, store } = setup();
		try {
			expect(() =>
				store.visibleRecordsPage(NAMESPACE, COLLECTION, null, 0),
			).toThrow(/positive integer/);
			expect(() =>
				store.visibleRecordsPage(NAMESPACE, COLLECTION, null, 1.5),
			).toThrow(/positive integer/);
		} finally {
			database.close();
		}
	});
});
