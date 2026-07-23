/**
 * Scalar V1 Authority Schema Recognition Tests
 *
 * Pins the boundary between Cloudflare-owned SQLite state and the exact
 * application schema owned by one scalar authority. SQLite-backed Durable
 * Objects expose their platform KV table in `sqlite_schema`; current Cloudflare
 * documentation and the repository's pinned workerd use two exact spellings.
 *
 * Key behaviors:
 * - the exact Cloudflare `__cf_kv` table may coexist with authority tables
 * - similarly named or unrelated application tables remain foreign schemas
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { openScalarAuthorityV1 } from './authority-v1.js';
import { authorityV1TestLimits } from './authority-v1-cases.test-support.js';
import { AUTHORITY_V1_FORMAT_VERSION } from './authority-v1-schema.js';

function setup(platformTable: string) {
	const raw = new Database(':memory:', { strict: true });
	raw.exec(`CREATE TABLE "${platformTable}" (key TEXT PRIMARY KEY) STRICT`);
	return { raw, database: createBunSqliteAdapter(raw) };
}

for (const platformTable of ['__cf_kv', '_cf_KV']) {
	test(`Cloudflare platform table ${platformTable} may coexist with the exact authority schema`, () => {
		const { raw, database } = setup(platformTable);
		try {
			openScalarAuthorityV1({
				database,
				limits: authorityV1TestLimits(),
				initialize: { authorityLifetime: 'lifetime-one' },
			});
			expect(() =>
				openScalarAuthorityV1({
					database,
					limits: authorityV1TestLimits(),
				}),
			).not.toThrow();
		} finally {
			raw.close();
		}
	});
}

test('a similarly prefixed application table is still a foreign schema', () => {
	for (const foreignTable of ['__cf_application', '_cf_application']) {
		const { raw, database } = setup(foreignTable);
		try {
			expect(() =>
				openScalarAuthorityV1({
					database,
					limits: authorityV1TestLimits(),
					initialize: { authorityLifetime: 'lifetime-one' },
				}),
			).toThrow(`schema does not match format ${AUTHORITY_V1_FORMAT_VERSION}`);
		} finally {
			raw.close();
		}
	}
});

test('an unrelated table beside an initialized authority remains foreign', () => {
	const { raw, database } = setup('__cf_kv');
	try {
		openScalarAuthorityV1({
			database,
			limits: authorityV1TestLimits(),
			initialize: { authorityLifetime: 'lifetime-one' },
		});
		raw.exec('CREATE TABLE foreign_state (id INTEGER PRIMARY KEY) STRICT');
		expect(() =>
			openScalarAuthorityV1({
				database,
				limits: authorityV1TestLimits(),
			}),
		).toThrow(`schema does not match format ${AUTHORITY_V1_FORMAT_VERSION}`);
	} finally {
		raw.close();
	}
});
