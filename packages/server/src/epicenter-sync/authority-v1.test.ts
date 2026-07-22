import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createAuthority,
	parseFactsRequest,
	parseSubmissionRequest,
	readFacts,
	submit,
	type ValidatedLimits,
} from '@epicenter/data/protocol/v1';
import type { SqliteRow, SqliteValue } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';

import { openScalarAuthorityV1 } from './authority-v1.js';
import {
	type AuthorityV1ConformanceBinding,
	authorityV1TestLimits,
	runAuthorityV1ConformanceCases,
} from './authority-v1-cases.test-support.js';

const pureReferenceBinding: AuthorityV1ConformanceBinding = {
	name: 'pure reference',
	open(limits, lifetime) {
		let state = expectOk(createAuthority(lifetime, limits));
		const authority = {
			readFacts: (request: Parameters<typeof readFacts>[1]) =>
				readFacts(state, request, limits),
			submit(request: Parameters<typeof submit>[1]) {
				const result = submit(state, request, limits);
				if (result.error !== null) return result;
				state = result.data.state;
				return Ok(result.data.response);
			},
		};
		return { authority, reopen: () => authority, close() {} };
	},
};

function sqliteBinding(
	name: string,
	adapt: (
		database: Database,
	) => Parameters<typeof openScalarAuthorityV1>[0]['database'],
): AuthorityV1ConformanceBinding {
	return {
		name,
		open(limits: ValidatedLimits, lifetime: string) {
			const raw = new Database(':memory:', { strict: true });
			const database = adapt(raw);
			const authority = openScalarAuthorityV1({
				database,
				limits,
				initialize: { authorityLifetime: lifetime },
			});
			return {
				authority,
				reopen: () => openScalarAuthorityV1({ database, limits }),
				close: () => raw.close(),
			};
		},
	};
}

const bunBinding = sqliteBinding('Bun SQLite', createBunSqliteAdapter);

const durableObjectBinding = sqliteBinding(
	'Durable Object SQLite adapter',
	(raw) => {
		const storage: DurableObjectSqliteStorage = {
			sql: {
				exec<TRow extends SqliteRow>(
					query: string,
					...bindings: SqliteValue[]
				) {
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
	},
);

runAuthorityV1ConformanceCases(pureReferenceBinding);
runAuthorityV1ConformanceCases(bunBinding);
runAuthorityV1ConformanceCases(durableObjectBinding);

describe('scalar V1 authority storage failures', () => {
	test('refuses a malformed same-named schema', () => {
		const raw = new Database(':memory:', { strict: true });
		try {
			raw.exec(`
				CREATE TABLE meta (singleton INTEGER PRIMARY KEY, format_version INTEGER);
				CREATE TABLE records (record_id INTEGER PRIMARY KEY);
				CREATE UNIQUE INDEX records_address ON records(record_id);
				CREATE UNIQUE INDEX records_sequence ON records(record_id);
				CREATE TABLE replica_witness (replica_id TEXT PRIMARY KEY);
				INSERT INTO meta VALUES (1, 1);
			`);
			expect(() =>
				openScalarAuthorityV1({
					database: createBunSqliteAdapter(raw),
					limits: authorityV1TestLimits(),
				}),
			).toThrow();
		} finally {
			raw.close();
		}
	});

	test('an interrupted initial schema transaction leaves no objects', () => {
		const raw = new Database(':memory:', { strict: true });
		const base = createBunSqliteAdapter(raw);
		let writes = 0;
		const failing = {
			...base,
			run(sql: string, parameters?: readonly SqliteValue[]) {
				base.run(sql, parameters);
				writes += 1;
				if (writes === 2) throw new Error('injected schema failure');
			},
		};
		try {
			expect(() =>
				openScalarAuthorityV1({
					database: failing,
					limits: authorityV1TestLimits(),
					initialize: { authorityLifetime: 'lifetime-one' },
				}),
			).toThrow('injected schema failure');
			expect(
				raw
					.query<{ name: string }, []>(
						`SELECT name FROM sqlite_schema
						WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'`,
					)
					.all(),
			).toEqual([]);
		} finally {
			raw.close();
		}
	});

	test('every submission write boundary crash reopens at the prior logical state', () => {
		const limits = authorityV1TestLimits();
		const directory = mkdtempSync(join(tmpdir(), 'epicenter-authority-v1-'));
		const path = join(directory, 'authority.sqlite');
		const raw = new Database(path, { create: true, strict: true });
		raw.run('PRAGMA journal_mode = DELETE');
		const base = createBunSqliteAdapter(raw);
		openScalarAuthorityV1({
			database: base,
			limits,
			initialize: { authorityLifetime: 'lifetime-one' },
		});
		const request = expectOk(
			parseSubmissionRequest(
				{
					authorityLifetime: 'lifetime-one',
					replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
					submissionNumber: 1,
					intents: [
						{
							address: {
								namespace: 'so.epicenter.notes',
								collection: 'recordings',
								recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
							},
							op: 'replace',
							value: 1,
						},
						{
							address: {
								namespace: 'so.epicenter.notes',
								collection: 'recordings',
								recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb',
							},
							op: 'replace',
							value: 2,
						},
					],
				},
				limits,
			),
		);

		try {
			for (let boundary = 1; boundary <= 4; boundary += 1) {
				let writes = 0;
				const crashedPath = join(directory, `crash-${boundary}.sqlite`);
				const crashAdapter = {
					...base,
					run(sql: string, parameters?: readonly SqliteValue[]) {
						base.run(sql, parameters);
						writes += 1;
						if (writes !== boundary) return;
						copyFileSync(path, crashedPath);
						const journal = `${path}-journal`;
						if (existsSync(journal)) {
							copyFileSync(journal, `${crashedPath}-journal`);
						}
						throw new Error(`injected crash ${boundary}`);
					},
				};
				const crashing = openScalarAuthorityV1({
					database: crashAdapter,
					limits,
				});
				expect(() => crashing.submit(request)).toThrow(
					`injected crash ${boundary}`,
				);

				const crashedRaw = new Database(crashedPath, { strict: true });
				try {
					const crashed = openScalarAuthorityV1({
						database: createBunSqliteAdapter(crashedRaw),
						limits,
					});
					const facts = expectOk(
						crashed.readFacts(
							expectOk(parseFactsRequest({ afterSequence: 0 }, limits)),
						),
					);
					expect(facts.facts).toEqual([]);
				} finally {
					crashedRaw.close();
				}
			}
		} finally {
			raw.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
