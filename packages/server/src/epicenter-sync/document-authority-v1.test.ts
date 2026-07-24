import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentPublicationRequest,
	documentPayloadDigest,
} from '@epicenter/data/document-v1';
import {
	parseFactsRequest,
	parseSubmissionRequest,
	type RecordAddress,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import { DOCUMENT_BOUND } from '@epicenter/sync/document-v3';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';

import {
	openScalarAuthorityV1,
	type ScalarAuthorityV1,
} from './authority-v1.js';

const ADDRESS: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'records',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};

function updateFor(value: string): Uint8Array {
	const document = new Y.Doc({ gc: true });
	let update: Uint8Array | undefined;
	document.on('updateV2', (next: Uint8Array) => {
		update = new Uint8Array(next);
	});
	document.get('content').insert(0, value);
	document.destroy();
	if (update === undefined) throw new Error('document update was not emitted');
	return update;
}

function dependentUpdates(...values: string[]): Uint8Array[] {
	const document = new Y.Doc({ gc: true });
	const updates: Uint8Array[] = [];
	document.on('updateV2', (update: Uint8Array) => {
		updates.push(new Uint8Array(update));
	});
	for (const value of values) document.get('content').insert(0, value);
	document.destroy();
	return updates;
}

function textOf(update: Uint8Array | undefined): string | undefined {
	if (update === undefined) return undefined;
	const document = new Y.Doc({ gc: true });
	try {
		Y.applyUpdateV2(document, update);
		return document.get('content').toString();
	} finally {
		document.destroy();
	}
}

function seedLive(authority: ScalarAuthorityV1, lifetime: string): void {
	expectOk(
		authority.submit(
			expectOk(
				parseSubmissionRequest(
					{
						authorityLifetime: lifetime,
						replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
						submissionNumber: 1,
						intents: [
							{ address: ADDRESS, op: 'replace', value: { title: 'live' } },
						],
					},
					SCALAR_SYNC_V1_LIMITS,
				),
			),
		),
	);
}

function publication(
	lifetime: string,
	payload: Uint8Array,
): DocumentPublicationRequest {
	return {
		authorityLifetime: lifetime,
		address: ADDRESS,
		protocolVersion: DOCUMENT_PUBLICATION_VERSION,
		payload,
		digest: documentPayloadDigest(payload),
	};
}

function createDurableObjectAdapter(raw: Database) {
	const storage: DurableObjectSqliteStorage = {
		sql: {
			exec<TRow extends SqliteRow>(query: string, ...bindings: SqliteValue[]) {
				const statement = raw.query(query);
				if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)) {
					return {
						toArray: () =>
							statement.all(...(bindings as SQLQueryBindings[])) as TRow[],
					};
				}
				statement.run(...(bindings as SQLQueryBindings[]));
				return { toArray: () => [] as TRow[] };
			},
		},
		transactionSync<TResult>(run: () => TResult): TResult {
			return raw.transaction(run).immediate();
		},
	} as DurableObjectSqliteStorage;
	return createDurableObjectSqliteAdapter(storage);
}

for (const [name, adapt] of [
	['Bun SQLite', createBunSqliteAdapter],
	['Durable Object SQLite', createDurableObjectAdapter],
] as const) {
	describe(`document authority: ${name}`, () => {
		function setup(live = true) {
			const raw = new Database(':memory:', { strict: true });
			const authority = openScalarAuthorityV1({
				database: adapt(raw),
				limits: SCALAR_SYNC_V1_LIMITS,
				initialize: { authorityLifetime: 'lifetime-one' },
			});
			if (live) seedLive(authority, 'lifetime-one');
			return { raw, authority };
		}

		test('joins a publication, returns exact postcommit proof, and retries idempotently', () => {
			const { raw, authority } = setup();
			try {
				const request = publication('lifetime-one', updateFor('accepted'));
				const first = authority.acceptDocument(request);
				expect(first).toEqual({
					kind: 'accepted',
					receipt: {
						authorityLifetime: request.authorityLifetime,
						address: request.address,
						protocolVersion: request.protocolVersion,
						digest: request.digest,
					},
				});
				expect(textOf(authority.exportDocument(ADDRESS))).toBe('accepted');
				expect(authority.acceptDocument(request)).toEqual(first);
				expect(
					raw
						.query<{ count: number }, []>(
							'SELECT count(*) AS count FROM record_documents',
						)
						.get()?.count,
				).toBe(1);
			} finally {
				raw.close();
			}
		});

		test('refuses over-bound state without mutating the accepted chain', () => {
			const { raw, authority } = setup();
			try {
				const before = authority.exportDocument(ADDRESS);
				const request = publication(
					'lifetime-one',
					updateFor('x'.repeat(DOCUMENT_BOUND.stateBytes + 1)),
				);
				const result = authority.acceptDocument(request);
				expect(result.kind).toBe('document-bound');
				expect(authority.exportDocument(ADDRESS)).toEqual(before);
			} finally {
				raw.close();
			}
		});

		/**
		 * Local premeasurement keeps over-bound payloads off the wire, but it
		 * cannot be the decision: the authority measures the state after joining
		 * every other replica's accumulation, which can cross the bound while
		 * each contributing replica's own document stays comfortably under it.
		 */
		test('refuses an under-bound publication whose post-join state is over-bound', () => {
			const { raw, authority } = setup();
			try {
				const half = 'x'.repeat(Math.floor(DOCUMENT_BOUND.stateBytes * 0.6));
				const [fromA, fromB] = [1, 2].map((clientId) => {
					const document = new Y.Doc({ gc: true });
					document.clientID = clientId;
					document.get('content').insert(0, half);
					const state = new Uint8Array(Y.encodeStateAsUpdateV2(document));
					document.destroy();
					return state;
				});
				if (fromA === undefined || fromB === undefined) {
					throw new Error('missing replica states');
				}
				// Each replica alone is legally publishable.
				for (const state of [fromA, fromB]) {
					expect(state.byteLength).toBeLessThan(DOCUMENT_BOUND.stateBytes);
				}

				expect(
					authority.acceptDocument(publication('lifetime-one', fromA)).kind,
				).toBe('accepted');
				const joined = authority.acceptDocument(
					publication('lifetime-one', fromB),
				);
				expect(joined.kind).toBe('document-bound');
				// The refusal leaves the previously accepted state untouched.
				expect(textOf(authority.exportDocument(ADDRESS))).toBe(half);
			} finally {
				raw.close();
			}
		});

		test('joins dependency-reordered updates and compacts a bounded tail', () => {
			const { raw, authority } = setup();
			try {
				const [first, second] = dependentUpdates('a', 'b');
				if (first === undefined || second === undefined) {
					throw new Error('missing dependent updates');
				}
				authority.acceptDocument(publication('lifetime-one', second));
				authority.acceptDocument(publication('lifetime-one', first));
				expect(textOf(authority.exportDocument(ADDRESS))).toBe('ba');

				for (let index = 0; index < 63; index += 1) {
					authority.acceptDocument(
						publication('lifetime-one', updateFor(String(index))),
					);
				}
				expect(
					raw
						.query<{ kind: string; count: number }, []>(
							`SELECT kind, count(*) AS count FROM record_documents
							GROUP BY kind`,
						)
						.all(),
				).toEqual([{ kind: 'baseline', count: 1 }]);
			} finally {
				raw.close();
			}
		});

		test('refuses stale lifetime and non-live records without creating a chain', () => {
			const { raw, authority } = setup(false);
			try {
				const update = updateFor('x');
				expect(authority.acceptDocument(publication('old', update))).toEqual({
					kind: 'lifetime-mismatch',
					activeAuthorityLifetime: 'lifetime-one',
				});
				expect(
					authority.acceptDocument(publication('lifetime-one', update)),
				).toMatchObject({ kind: 'record-not-live', state: 'absent' });
				expect(authority.exportDocument(ADDRESS)).toBeUndefined();
			} finally {
				raw.close();
			}
		});

		test('a scalar tombstone reaps the accepted chain in the same owner', () => {
			const { raw, authority } = setup();
			try {
				authority.acceptDocument(
					publication('lifetime-one', updateFor('doomed')),
				);
				expectOk(
					authority.submit(
						expectOk(
							parseSubmissionRequest(
								{
									authorityLifetime: 'lifetime-one',
									replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
									submissionNumber: 2,
									intents: [{ address: ADDRESS, op: 'tombstone' }],
								},
								SCALAR_SYNC_V1_LIMITS,
							),
						),
					),
				);
				expect(authority.exportDocument(ADDRESS)).toBeUndefined();
				expect(
					expectOk(
						authority.readFacts(
							expectOk(
								parseFactsRequest(
									{ authorityLifetime: 'lifetime-one', afterSequence: 1 },
									SCALAR_SYNC_V1_LIMITS,
								),
							),
						),
					).facts[0]?.state,
				).toBe('tombstone');
			} finally {
				raw.close();
			}
		});
	});
}
