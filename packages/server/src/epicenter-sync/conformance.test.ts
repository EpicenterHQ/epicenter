/**
 * Epicenter Sync Authority and Replica Conformance Tests
 *
 * Runs the real Data SQLite replica engine against the real server authority
 * in-process to prove convergence across retries, forks, pages, tombstones,
 * and authority-lifetime replacement.
 *
 * Key behaviors:
 * - Rows, values, unsets, and permanent deletions converge across replicas
 * - Dropped responses, fork recovery, and page-install crashes are retry safe
 * - Fresh replicas drain the authority through bounded watermark pages
 * - A replaced authority lifetime refuses old replicas until they erase and
 *   reacquire the successor state
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openReplica } from '@epicenter/data';
import type { Change, ExchangeRequest } from '@epicenter/data/protocol';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { openEpicenterSyncAuthority } from './authority.js';

const DEPLOYMENT = 'https://example.com/';
const PRINCIPAL = 'principal-a';
const NAMESPACE = 'so.epicenter.tests';
const TABLE = 'rows';
const ROW_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ROW_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const rowA = { namespace: NAMESPACE, table: TABLE, rowId: ROW_A };
const rowB = { namespace: NAMESPACE, table: TABLE, rowId: ROW_B };
const setValue = (value: string, payload: unknown): Change => ({
	kind: 'set',
	namespace: NAMESPACE,
	value,
	payload: payload as Change extends { payload: infer P } ? P : never,
});

function openAttachedReplica(raw: Database, replicaId: string) {
	const replica = expectOk(
		openReplica({
			database: createBunSqliteAdapter(raw),
			mintReplicaId: () => replicaId,
		}),
	);
	expectOk(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: PRINCIPAL }),
	);
	return replica;
}

test('two replicas converge across row changes, deletion, value unset, and later set', async () => {
	const authorityDatabase = new Database(':memory:');
	const authority = openEpicenterSyncAuthority({
		database: createBunSqliteAdapter(authorityDatabase),
		pageSize: 1,
	});
	const firstDatabase = new Database(':memory:');
	const secondDatabase = new Database(':memory:');
	const first = openAttachedReplica(firstDatabase, 'aaaaaaaaaaaaaaaaaaaaaaa1');
	const second = openAttachedReplica(
		secondDatabase,
		'bbbbbbbbbbbbbbbbbbbbbbb2',
	);

	expectOk(
		first.write({
			kind: 'create',
			...rowA,
			fields: { title: 'keep', note: 'remove' },
		}),
	);
	expectOk(
		first.write({ kind: 'create', ...rowB, fields: { title: 'offline' } }),
	);
	expectOk(first.write(setValue('value', 'first')));
	expectOk(await first.synchronize(authority.exchange));
	expectOk(await second.synchronize(authority.exchange));

	expectOk(
		second.write({
			kind: 'update',
			...rowA,
			fields: { set: { title: 'updated' }, unset: ['note'] },
		}),
	);
	expectOk(second.write({ kind: 'delete', ...rowB }));
	expectOk(
		second.write({ kind: 'unset', namespace: NAMESPACE, value: 'value' }),
	);
	expectOk(await second.synchronize(authority.exchange));

	// A stale optimistic edit against the tombstoned row loses: the benign
	// noop touch re-delivers the tombstone in the same convergence pass.
	expectOk(
		first.write({
			kind: 'update',
			...rowB,
			fields: { set: { title: 'stale-live' }, unset: [] },
		}),
	);
	expectOk(await first.synchronize(authority.exchange));
	expect(expectOk(first.readRow(rowA))).toEqual({ title: 'updated' });
	expect(expectOk(first.readRow(rowB))).toBeUndefined();
	expect(
		expectOk(first.readValue({ namespace: NAMESPACE, value: 'value' })),
	).toBeUndefined();

	expectOk(first.write(setValue('value', 'second')));
	expectOk(await first.synchronize(authority.exchange));
	expectOk(await second.synchronize(authority.exchange));
	expect(expectOk(second.readRow(rowA))).toEqual({ title: 'updated' });
	expect(expectOk(second.readRow(rowB))).toBeUndefined();
	expect(
		expectOk(second.readValue({ namespace: NAMESPACE, value: 'value' })),
	).toBe('second');

	firstDatabase.close();
	secondDatabase.close();
	authorityDatabase.close();
});

test('fresh sequence-zero replica drains full state through bounded watermark pages', async () => {
	const authorityDatabase = new Database(':memory:');
	const authority = openEpicenterSyncAuthority({
		database: createBunSqliteAdapter(authorityDatabase),
		pageSize: 1,
	});
	const writerDatabase = new Database(':memory:');
	const writer = openAttachedReplica(
		writerDatabase,
		'wwwwwwwwwwwwwwwwwwwwwww1',
	);
	expectOk(writer.write(setValue('a', 1)));
	expectOk(writer.write(setValue('b', 2)));
	expectOk(writer.write(setValue('c', 3)));
	expectOk(await writer.synchronize(authority.exchange));

	const freshDatabase = new Database(':memory:');
	const fresh = openAttachedReplica(freshDatabase, 'fffffffffffffffffffffff2');
	let calls = 0;
	const requests: ExchangeRequest[] = [];
	expectOk(
		await fresh.synchronize((request) => {
			calls += 1;
			requests.push(structuredClone(request));
			return authority.exchange(request);
		}),
	);
	expect(calls).toBe(3);
	// Continuations reuse the sampled through and advance the durable after.
	expect(requests[1]?.through).toBe(requests[1] === undefined ? 0 : 3);
	expect(requests.map((request) => request.after)).toEqual([0, 1, 2]);
	expect(expectOk(fresh.readValue({ namespace: NAMESPACE, value: 'a' }))).toBe(
		1,
	);
	expect(expectOk(fresh.readValue({ namespace: NAMESPACE, value: 'b' }))).toBe(
		2,
	);
	expect(expectOk(fresh.readValue({ namespace: NAMESPACE, value: 'c' }))).toBe(
		3,
	);

	freshDatabase.close();
	writerDatabase.close();
	authorityDatabase.close();
});

test('dropped response retries the exact multi-change batch and applies it once', async () => {
	const authorityDatabase = new Database(':memory:');
	const authority = openEpicenterSyncAuthority({
		database: createBunSqliteAdapter(authorityDatabase),
	});
	const replicaDatabase = new Database(':memory:');
	const replica = openAttachedReplica(
		replicaDatabase,
		'rrrrrrrrrrrrrrrrrrrrrrr1',
	);
	expectOk(replica.write(setValue('a', 1)));
	expectOk(replica.write(setValue('b', 2)));
	let firstRequest: ExchangeRequest | undefined;
	const lost = await replica.synchronize((request) => {
		firstRequest = structuredClone(request);
		authority.exchange(request);
		throw new Error('dropped response');
	});
	expect(expectErr(lost).name).toBe('TransportFailed');
	let retryRequest: ExchangeRequest | undefined;
	expectOk(
		await replica.synchronize((request) => {
			retryRequest = structuredClone(request);
			return authority.exchange(request);
		}),
	);
	expect(retryRequest).toEqual(firstRequest);
	expect(
		authorityDatabase
			.query<{ next_sequence: number }, []>(
				'SELECT next_sequence FROM metadata',
			)
			.get()?.next_sequence,
	).toBe(3);

	replicaDatabase.close();
	authorityDatabase.close();
});

test('forked replica remints its identity, resubmits, and converges', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-sync-fork-'));
	const originalPath = join(directory, 'original.sqlite');
	const copyPath = join(directory, 'copy.sqlite');
	const authorityDatabase = new Database(':memory:');
	try {
		const authority = openEpicenterSyncAuthority({
			database: createBunSqliteAdapter(authorityDatabase),
		});
		const originalDatabase = new Database(originalPath);
		const original = openAttachedReplica(
			originalDatabase,
			'ooooooooooooooooooooooo1',
		);
		expectOk(original.write(setValue('value', 'base')));
		expectOk(await original.synchronize(authority.exchange));
		copyFileSync(originalPath, copyPath);
		expectOk(original.write(setValue('value', 'original')));
		expectOk(await original.synchronize(authority.exchange));

		const copyDatabase = new Database(copyPath);
		const copied = expectOk(
			openReplica({
				database: createBunSqliteAdapter(copyDatabase),
				mintReplicaId: () => 'ccccccccccccccccccccccc2',
			}),
		);
		const before = expectOk(copied.metadata()).replicaId;
		expectOk(copied.write(setValue('value', 'copy')));
		expectOk(await copied.synchronize(authority.exchange));
		expect(expectOk(copied.metadata()).replicaId).not.toBe(before);
		expect(
			expectOk(copied.readValue({ namespace: NAMESPACE, value: 'value' })),
		).toBe('copy');
		expectOk(await original.synchronize(authority.exchange));
		expect(
			expectOk(original.readValue({ namespace: NAMESPACE, value: 'value' })),
		).toBe('copy');
		copyDatabase.close();
		originalDatabase.close();
	} finally {
		authorityDatabase.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test('a page crash rolls back atomically and the resumed scan converges from durable progress', async () => {
	const authorityDatabase = new Database(':memory:');
	const authority = openEpicenterSyncAuthority({
		database: createBunSqliteAdapter(authorityDatabase),
		pageSize: 1,
	});
	const writerDatabase = new Database(':memory:');
	const writer = openAttachedReplica(
		writerDatabase,
		'wwwwwwwwwwwwwwwwwwwwwww2',
	);
	expectOk(writer.write(setValue('a', 1)));
	expectOk(writer.write(setValue('b', 2)));
	expectOk(await writer.synchronize(authority.exchange));

	const replicaDatabase = new Database(':memory:');
	const base = createBunSqliteAdapter(replicaDatabase);
	let failWatermarkAdvance = true;
	const crashing = {
		...base,
		run(sql: string, parameters?: Parameters<typeof base.run>[1]) {
			if (
				failWatermarkAdvance &&
				sql.includes('last_applied_authority_sequence = ?')
			) {
				failWatermarkAdvance = false;
				throw new Error('simulated page crash');
			}
			base.run(sql, parameters);
		},
	};
	const replica = expectOk(
		openReplica({
			database: crashing,
			mintReplicaId: () => 'xxxxxxxxxxxxxxxxxxxxxxx3',
		}),
	);
	expectOk(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: PRINCIPAL }),
	);
	expect(expectErr(await replica.synchronize(authority.exchange)).name).toBe(
		'StorageFailed',
	);
	// The record install and watermark advance share one transaction.
	expect(expectOk(replica.metadata()).lastAppliedAuthoritySequence).toBe(0);
	expect(
		expectOk(replica.readValue({ namespace: NAMESPACE, value: 'a' })),
	).toBeUndefined();
	expectOk(await replica.synchronize(authority.exchange));
	expect(expectOk(replica.metadata()).lastAppliedAuthoritySequence).toBe(2);
	expect(
		expectOk(replica.readValue({ namespace: NAMESPACE, value: 'a' })),
	).toBe(1);
	expect(
		expectOk(replica.readValue({ namespace: NAMESPACE, value: 'b' })),
	).toBe(2);

	replicaDatabase.close();
	writerDatabase.close();
	authorityDatabase.close();
});

test('authority reopen preserves the lifetime, head, and receipts', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-sync-reopen-'));
	try {
		const path = join(directory, 'authority.sqlite');
		const firstRaw = new Database(path);
		const firstAuthority = openEpicenterSyncAuthority({
			database: createBunSqliteAdapter(firstRaw),
		});
		const replicaDatabase = new Database(':memory:');
		const replica = openAttachedReplica(
			replicaDatabase,
			'rrrrrrrrrrrrrrrrrrrrrrr4',
		);
		expectOk(replica.write(setValue('value', 'durable')));
		expectOk(await replica.synchronize(firstAuthority.exchange));
		const lifetime = expectOk(replica.metadata()).authorityLifetime;
		firstRaw.close();

		const secondRaw = new Database(path);
		const secondAuthority = openEpicenterSyncAuthority({
			database: createBunSqliteAdapter(secondRaw),
		});
		// Same lifetime, same head, same receipt: the reopened authority
		// accepts the bound replica and its next batch without conflict.
		expectOk(replica.write(setValue('value', 'after-restart')));
		expectOk(await replica.synchronize(secondAuthority.exchange));
		expect(expectOk(replica.metadata()).authorityLifetime).toBe(lifetime);
		expect(
			expectOk(replica.readValue({ namespace: NAMESPACE, value: 'value' })),
		).toBe('after-restart');
		secondRaw.close();
		replicaDatabase.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('a successor authority lifetime refuses old replicas until they erase and reacquire', async () => {
	const outgoingDatabase = new Database(':memory:');
	const outgoing = openEpicenterSyncAuthority({
		database: createBunSqliteAdapter(outgoingDatabase),
	});
	const replicaDatabase = new Database(':memory:');
	const replica = openAttachedReplica(
		replicaDatabase,
		'rrrrrrrrrrrrrrrrrrrrrrr5',
	);
	expectOk(
		replica.write({ kind: 'create', ...rowA, fields: { title: 'outgoing' } }),
	);
	expectOk(await replica.synchronize(outgoing.exchange));
	const oldLifetime = expectOk(replica.metadata()).authorityLifetime;

	// Restore at the contract seam: a fresh authority constructed from
	// replacement state under a freshly minted lifetime.
	const successorDatabase = new Database(':memory:');
	const successor = openEpicenterSyncAuthority({
		database: createBunSqliteAdapter(successorDatabase),
	});
	const seedDatabase = new Database(':memory:');
	const seeder = openAttachedReplica(seedDatabase, 'ssssssssssssssssssssssss');
	expectOk(
		seeder.write({ kind: 'create', ...rowB, fields: { title: 'restored' } }),
	);
	expectOk(await seeder.synchronize(successor.exchange));

	// Pending old-lifetime work is intentionally abandoned by the reset.
	expectOk(replica.write(setValue('value', 'doomed')));
	expectOk(await replica.synchronize(successor.exchange));
	const rebound = expectOk(replica.metadata());
	expect(rebound.authorityLifetime).not.toBe(oldLifetime);
	expect(expectOk(replica.readRow(rowA))).toBeUndefined();
	expect(expectOk(replica.readRow(rowB))).toEqual({ title: 'restored' });
	expect(
		expectOk(replica.readValue({ namespace: NAMESPACE, value: 'value' })),
	).toBeUndefined();
	// The successor accepted nothing from the outgoing lifetime.
	expect(
		successorDatabase
			.query<{ count: number }, []>(
				"SELECT COUNT(*) AS count FROM state WHERE address_kind = 'value'",
			)
			.get()?.count,
	).toBe(0);

	seedDatabase.close();
	successorDatabase.close();
	replicaDatabase.close();
	outgoingDatabase.close();
});
