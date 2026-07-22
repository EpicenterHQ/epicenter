/**
 * OAuth Client Seed Reconciliation Tests
 *
 * Verifies the deployment seed removes only the explicitly retired first-party
 * clients and upserts the retained registry in one transaction.
 *
 * Key behaviors:
 * - The retired client IDs are deleted explicitly
 * - Only the retained client registry is upserted
 * - A failed reconciliation rolls back instead of committing a partial registry
 */

import { expect, test } from 'bun:test';
import { reconcileTrustedOAuthClients } from './seed-oauth-clients.js';

type QueryCall = { sql: string; values?: unknown[] };

test('reconciliation deletes retired clients and upserts only retained clients', async () => {
	const calls: QueryCall[] = [];
	const clientCount = await reconcileTrustedOAuthClients(
		{
			async query(sql, values) {
				calls.push({ sql, values });
			},
		},
		'https://api.epicenter.so',
	);

	expect(clientCount).toBe(4);
	expect(calls[0]?.sql).toBe('BEGIN');
	expect(calls[1]?.sql).toContain('DELETE FROM oauth_client');
	expect(calls[1]?.values).toEqual([
		['epicenter-opensidian', 'epicenter-tab-manager', 'epicenter-vocab'],
	]);
	expect(
		calls
			.filter((call) => call.sql.includes('INSERT INTO oauth_client'))
			.map((call) => call.values?.[1]),
	).toEqual([
		'epicenter-desktop',
		'epicenter-whispering',
		'epicenter-honeycrisp',
		'epicenter-cli',
	]);
	expect(calls.at(-1)?.sql).toBe('COMMIT');
});

test('reconciliation rolls back when a retained client upsert fails', async () => {
	const calls: QueryCall[] = [];
	const failure = new Error('upsert failed');

	await expect(
		reconcileTrustedOAuthClients(
			{
				async query(sql, values) {
					calls.push({ sql, values });
					if (sql.includes('INSERT INTO oauth_client')) throw failure;
				},
			},
			'https://api.epicenter.so',
		),
	).rejects.toBe(failure);

	expect(calls.at(-1)?.sql).toBe('ROLLBACK');
	expect(calls.some((call) => call.sql === 'COMMIT')).toBe(false);
});
