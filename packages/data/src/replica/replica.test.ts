/**
 * SQLite Replica Tests
 *
 * Verifies durable identity and attachment, optimistic writes, exact batch
 * retry, fork recovery, lifetime binding and replacement, parked refusals,
 * and per-page watermark crash safety against a scripted authority.
 *
 * Key behaviors:
 * - Opening preserves identity and rejects unknown formats
 * - A fresh replica binds the returned lifetime; mismatch wipes and rebinds
 * - Each installed page advances the durable watermark; crashes reinstall
 *   nothing that already committed
 * - Refused work parks visibly and never blocks authoritative truth
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
	batchDigest,
	type Change,
	type ExchangeRequest,
	type ExchangeResponse,
	foldChange,
	type Record as SyncRecord,
	scalarAddressKey,
	scalarAddressOf,
} from '../protocol/index.js';
import { openReplica } from './replica.js';

const NAMESPACE = 'so.epicenter.notes';
const TABLE = 'rows';
const VALUE_NAMESPACE = 'so.epicenter.settings';
const VALUE = 'theme';
const ROW_ID = 'abc123def456ghi789jkl012';
const DEPLOYMENT = 'https://example.com/';
const PRINCIPAL = 'principal-a';
const LIFETIME_A = 'aaaaaaaaaaaaaaaaaaaaaaal';
const LIFETIME_B = 'bbbbbbbbbbbbbbbbbbbbbbbl';

const setTheme = (payload: string): Change => ({
	kind: 'set',
	namespace: VALUE_NAMESPACE,
	value: VALUE,
	payload,
});

const rowAddress = { namespace: NAMESPACE, table: TABLE, rowId: ROW_ID };
const themeAddress = { namespace: VALUE_NAMESPACE, value: VALUE };

function addressOf(value: Change | SyncRecord): string {
	return scalarAddressKey(scalarAddressOf(value));
}

function createScriptedAuthority({
	pageSize = 64,
	lifetimeId = LIFETIME_A,
}: {
	pageSize?: number;
	lifetimeId?: string;
} = {}) {
	let lifetime = lifetimeId;
	let nextSequence = 1;
	let appliedChanges = 0;
	let conflicts = 0;
	let state = new Map<string, SyncRecord>();
	let receipts = new Map<string, { seq: number; digest: string }>();

	function submit(change: Change): void {
		const address = addressOf(change);
		const folded = foldChange(state.get(address), change, nextSequence);
		if (folded.kind === 'applied') {
			state.set(address, structuredClone(folded.record));
			nextSequence += 1;
			appliedChanges += 1;
		} else if (folded.kind === 'noop' && folded.current !== undefined) {
			state.set(address, {
				...structuredClone(folded.current),
				changedSequence: nextSequence,
			});
			nextSequence += 1;
		}
	}

	function exchange(request: ExchangeRequest): ExchangeResponse {
		if (request.lifetimeId !== null && request.lifetimeId !== lifetime) {
			return { refusal: 'lifetime-mismatch', lifetimeId: lifetime };
		}
		const head = nextSequence - 1;
		if (
			request.after > head ||
			(request.through !== undefined && request.through > head)
		) {
			return { refusal: 'checkpoint-ahead', lifetimeId: lifetime };
		}
		let receipt: { seq: number; digest: string } | undefined;
		if (request.batch !== undefined) {
			const prior = receipts.get(request.replicaId);
			if (prior !== undefined && prior.seq === request.batch.seq) {
				if (prior.digest !== request.batch.digest) {
					conflicts += 1;
					return { refusal: 'batch-conflict', lifetimeId: lifetime };
				}
				receipt = prior;
			} else if (request.batch.seq !== (prior?.seq ?? 0) + 1) {
				conflicts += 1;
				return { refusal: 'batch-conflict', lifetimeId: lifetime };
			} else if (request.batch.digest !== batchDigest(request.batch.changes)) {
				conflicts += 1;
				return { refusal: 'batch-conflict', lifetimeId: lifetime };
			} else {
				// Whole-envelope admission before any mutation.
				const staged = new Map<string, SyncRecord>();
				let stagedSequence = nextSequence;
				for (const [index, change] of request.batch.changes.entries()) {
					const address = addressOf(change);
					const current = staged.get(address) ?? state.get(address);
					const folded = foldChange(current, change, stagedSequence);
					if (folded.kind === 'inadmissible') {
						return {
							refusal: 'change-inadmissible',
							lifetimeId: lifetime,
							seq: request.batch.seq,
							digest: request.batch.digest,
							changeIndex: index,
							reason: folded.reason,
						};
					}
					if (folded.kind === 'applied') {
						staged.set(address, structuredClone(folded.record));
						stagedSequence += 1;
						appliedChanges += 1;
					} else if (folded.current !== undefined && !staged.has(address)) {
						staged.set(address, {
							...structuredClone(folded.current),
							changedSequence: stagedSequence,
						});
						stagedSequence += 1;
					}
				}
				for (const [address, record] of staged) state.set(address, record);
				nextSequence = stagedSequence;
				receipt = { seq: request.batch.seq, digest: request.batch.digest };
				receipts.set(request.replicaId, receipt);
			}
		}

		const through = request.through ?? nextSequence - 1;
		const eligible = [...state.values()]
			.filter(
				(record) =>
					record.changedSequence > request.after &&
					record.changedSequence <= through,
			)
			.sort((left, right) => left.changedSequence - right.changedSequence);
		const records = eligible
			.slice(0, pageSize)
			.map((record) => structuredClone(record));
		return {
			lifetimeId: lifetime,
			...(receipt === undefined ? {} : { receipt }),
			through,
			records,
			more: eligible.length > pageSize,
		};
	}

	return {
		exchange,
		submit,
		/** Model Restore: a fresh authority lifetime built from replacement state. */
		replaceLifetime(next: string, seed: readonly Change[] = []) {
			lifetime = next;
			state = new Map();
			receipts = new Map();
			nextSequence = 1;
			for (const change of seed) submit(change);
		},
		get appliedChanges() {
			return appliedChanges;
		},
		get conflicts() {
			return conflicts;
		},
		get maximumSequence() {
			return nextSequence - 1;
		},
	};
}

function setup(database = new Database(':memory:')) {
	const adapter = createBunSqliteAdapter(database);
	const replica = expectOk(openReplica({ database: adapter }));
	expectOk(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: PRINCIPAL }),
	);
	return { database, adapter, replica };
}

test('fresh open mints identity and reopen preserves it', () => {
	const database = new Database(':memory:');
	const adapter = createBunSqliteAdapter(database);
	const first = expectOk(openReplica({ database: adapter }));
	const firstMetadata = expectOk(first.metadata());
	expect(firstMetadata.replicaId).toMatch(/^[a-z0-9]{24}$/);
	expect(firstMetadata.formatVersion).toBe(2);
	expect(firstMetadata.authorityLifetime).toBeNull();
	const reopened = expectOk(openReplica({ database: adapter }));
	expect(expectOk(reopened.metadata())).toEqual(firstMetadata);
	database.close();
});

test('the flat-key format 1 store is refused without rewriting metadata', () => {
	const database = new Database(':memory:');
	database.run(`CREATE TABLE metadata (
		singleton INTEGER PRIMARY KEY,
		format_version INTEGER NOT NULL,
		replica_id TEXT NOT NULL,
		attached_deployment TEXT,
		attached_principal TEXT,
		last_applied_authority_sequence INTEGER NOT NULL
	) STRICT`);
	database.run(
		"INSERT INTO metadata VALUES (1, 1, 'rrrrrrrrrrrrrrrrrrrrrrrr', NULL, NULL, 0)",
	);
	const error = expectErr(
		openReplica({ database: createBunSqliteAdapter(database) }),
	);
	expect(error.name).toBe('UnsupportedFormat');
	expect(
		database
			.query<{ format_version: number }, []>(
				'SELECT format_version FROM metadata',
			)
			.get()?.format_version,
	).toBe(1);
	database.close();
});

test('attachment is idempotent and another principal is refused before exchange', async () => {
	const { database, replica } = setup();
	expectOk(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: PRINCIPAL }),
	);
	const error = expectErr(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: 'principal-b' }),
	);
	expect(error.name).toBe('WrongAttachment');
	let exchangeCalls = 0;
	const result = await replica.synchronize(() => {
		exchangeCalls += 1;
		return {
			lifetimeId: LIFETIME_A,
			through: 0,
			records: [],
			more: false,
		};
	});
	expectOk(result);
	expect(exchangeCalls).toBe(1);
	expect(expectOk(replica.metadata()).attachment).toEqual({
		deploymentId: DEPLOYMENT,
		principalId: PRINCIPAL,
	});
	database.close();
});

test('attachment requires the canonical deployment URL', () => {
	const database = new Database(':memory:');
	const replica = expectOk(
		openReplica({ database: createBunSqliteAdapter(database) }),
	);
	expect(
		expectErr(
			replica.attach({
				deploymentId: 'https://example.com',
				principalId: PRINCIPAL,
			}),
		).name,
	).toBe('InvalidInput');
	expect(expectOk(replica.metadata()).attachment).toBeUndefined();
	database.close();
});

test('local writes expose the optimistic overlay before authority receipt', () => {
	const { database, replica } = setup();
	expect(
		expectOk(
			replica.write({
				kind: 'create',
				...rowAddress,
				fields: { title: 'A', old: true },
			}),
		).applied,
	).toBe(true);
	expect(
		expectOk(
			replica.write({
				kind: 'update',
				...rowAddress,
				fields: { set: { title: 'B' }, unset: ['old'] },
			}),
		).applied,
	).toBe(true);
	expect(expectOk(replica.readRow(rowAddress))).toEqual({ title: 'B' });
	expectOk(replica.write(setTheme('dark')));
	expect(expectOk(replica.readValue(themeAddress))).toBe('dark');
	database.close();
});

test('a fresh replica sends a null lifetime, may upload immediately, and binds the returned lifetime', async () => {
	const { database, replica } = setup();
	const authority = createScriptedAuthority();
	expectOk(replica.write(setTheme('dark')));
	const requests: ExchangeRequest[] = [];
	expectOk(
		await replica.synchronize((request) => {
			requests.push(structuredClone(request));
			return authority.exchange(request);
		}),
	);
	expect(requests[0]?.lifetimeId).toBeNull();
	expect(requests[0]?.batch?.changes).toHaveLength(1);
	expect(expectOk(replica.metadata()).authorityLifetime).toBe(LIFETIME_A);
	expect(authority.appliedChanges).toBe(1);

	// Every later request presents the exact bound lifetime.
	expectOk(replica.write(setTheme('light')));
	expectOk(
		await replica.synchronize((request) => {
			requests.push(structuredClone(request));
			return authority.exchange(request);
		}),
	);
	expect(requests.at(-1)?.lifetimeId).toBe(LIFETIME_A);
	database.close();
});

test('lost batch response retries exact bytes and authority applies once', async () => {
	const { database, replica } = setup();
	const authority = createScriptedAuthority();
	expectOk(replica.write(setTheme('dark')));
	let loseFirstResponse = true;
	const first = await replica.synchronize((request) => {
		const response = authority.exchange(request);
		if (loseFirstResponse) {
			loseFirstResponse = false;
			throw new Error('response lost');
		}
		return response;
	});
	expect(expectErr(first).name).toBe('TransportFailed');
	expectOk(await replica.synchronize(authority.exchange));
	expect(authority.appliedChanges).toBe(1);
	expect(expectOk(replica.readValue(themeAddress))).toBe('dark');
	database.close();
});

test('multiple pending changes seal atomically and retry as one exact batch', async () => {
	const { database, replica } = setup();
	const authority = createScriptedAuthority();
	expectOk(replica.write(setTheme('dark')));
	expectOk(
		replica.write({
			kind: 'create',
			...rowAddress,
			fields: { title: 'batched' },
		}),
	);
	let firstRequest: ExchangeRequest | undefined;
	const lost = await replica.synchronize((request) => {
		firstRequest = structuredClone(request);
		authority.exchange(request);
		throw new Error('response lost');
	});
	expect(expectErr(lost).name).toBe('TransportFailed');
	let retryRequest: ExchangeRequest | undefined;
	expectOk(
		await replica.synchronize((request) => {
			retryRequest = structuredClone(request);
			return authority.exchange(request);
		}),
	);
	expect(firstRequest?.batch?.changes).toHaveLength(2);
	expect(retryRequest).toEqual(firstRequest);
	expect(authority.appliedChanges).toBe(2);
	expect(expectOk(replica.readValue(themeAddress))).toBe('dark');
	expect(expectOk(replica.readRow(rowAddress))).toEqual({ title: 'batched' });
	database.close();
});

test('drained reopen preserves the next batch sequence and replica identity', async () => {
	const database = new Database(':memory:');
	const adapter = createBunSqliteAdapter(database);
	const replica = expectOk(openReplica({ database: adapter }));
	expectOk(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: PRINCIPAL }),
	);
	const authority = createScriptedAuthority();
	expectOk(replica.write(setTheme('first')));
	expectOk(await replica.synchronize(authority.exchange));
	const identity = expectOk(replica.metadata()).replicaId;

	const reopened = expectOk(openReplica({ database: adapter }));
	expectOk(reopened.write(setTheme('second')));
	expectOk(await reopened.synchronize(authority.exchange));
	expect(expectOk(reopened.metadata()).replicaId).toBe(identity);
	expect(authority.conflicts).toBe(0);
	expect(authority.appliedChanges).toBe(2);
	database.close();
});

test('copied replica conflict remints identity, preserves the watermark, and converges', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'epicenter-data-fork-'));
	const originalPath = join(directory, 'original.sqlite');
	const copyPath = join(directory, 'copy.sqlite');
	try {
		const originalDatabase = new Database(originalPath);
		const original = setup(originalDatabase).replica;
		const authority = createScriptedAuthority();
		expectOk(original.write(setTheme('baseline')));
		expectOk(await original.synchronize(authority.exchange));
		copyFileSync(originalPath, copyPath);

		expectOk(original.write(setTheme('original')));
		expectOk(await original.synchronize(authority.exchange));

		const copyDatabase = new Database(copyPath);
		const copied = expectOk(
			openReplica({
				database: createBunSqliteAdapter(copyDatabase),
				mintReplicaId: () => 'ssssssssssssssssssssssss',
			}),
		);
		const copiedBefore = expectOk(copied.metadata());
		expectOk(copied.write(setTheme('copied')));
		expectOk(await copied.synchronize(authority.exchange));
		const copiedAfter = expectOk(copied.metadata());
		expect(copiedAfter.replicaId).not.toBe(copiedBefore.replicaId);
		expect(copiedAfter.lastAppliedAuthoritySequence).toBeGreaterThanOrEqual(
			copiedBefore.lastAppliedAuthoritySequence,
		);
		expect(copiedAfter.lastBatchSequence).toBe(1);
		expect(authority.conflicts).toBe(1);
		expect(expectOk(copied.readValue(themeAddress))).toBe('copied');
		copyDatabase.close();
		originalDatabase.close();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('a crash inside a page transaction rolls the whole page back and retries idempotently', async () => {
	const database = new Database(':memory:');
	const base = createBunSqliteAdapter(database);
	let failWatermarkAdvance = true;
	const crashing = {
		...base,
		run(
			sql: string,
			parameters?: readonly (string | number | null | Uint8Array)[],
		) {
			if (
				failWatermarkAdvance &&
				sql.includes('last_applied_authority_sequence = ?')
			) {
				failWatermarkAdvance = false;
				throw new Error('simulated crash');
			}
			base.run(sql, parameters);
		},
	};
	const replica = expectOk(openReplica({ database: crashing }));
	expectOk(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: PRINCIPAL }),
	);
	const authority = createScriptedAuthority({ pageSize: 1 });
	authority.submit(setTheme('remote'));
	const failed = await replica.synchronize(authority.exchange);
	expect(expectErr(failed).name).toBe('StorageFailed');
	// The record install and the watermark advance share one transaction, so
	// the failed page left neither behind.
	expect(expectOk(replica.readValue(themeAddress))).toBeUndefined();
	expect(expectOk(replica.metadata()).lastAppliedAuthoritySequence).toBe(0);
	expectOk(await replica.synchronize(authority.exchange));
	expect(expectOk(replica.metadata()).lastAppliedAuthoritySequence).toBe(1);
	expect(expectOk(replica.readValue(themeAddress))).toBe('remote');
	database.close();
});

test('a crash between pages resumes from durable progress without re-requesting completed pages', async () => {
	const database = new Database(':memory:');
	const base = createBunSqliteAdapter(database);
	let watermarkWrites = 0;
	let crashOnSecondPage = true;
	const crashing = {
		...base,
		run(
			sql: string,
			parameters?: readonly (string | number | null | Uint8Array)[],
		) {
			if (sql.includes('last_applied_authority_sequence = ?')) {
				watermarkWrites += 1;
				if (crashOnSecondPage && watermarkWrites === 2) {
					crashOnSecondPage = false;
					throw new Error('simulated crash');
				}
			}
			base.run(sql, parameters);
		},
	};
	const replica = expectOk(openReplica({ database: crashing }));
	expectOk(
		replica.attach({ deploymentId: DEPLOYMENT, principalId: PRINCIPAL }),
	);
	const authority = createScriptedAuthority({ pageSize: 1 });
	authority.submit(setTheme('one'));
	authority.submit({
		kind: 'set',
		namespace: VALUE_NAMESPACE,
		value: 'other',
		payload: 'two',
	});
	authority.submit({
		kind: 'set',
		namespace: VALUE_NAMESPACE,
		value: 'third',
		payload: 'three',
	});

	const installs: string[] = [];
	const stopSubscription = replica.subscribe((changes) => {
		for (const change of changes) installs.push(scalarAddressKey(change));
	});
	const requests: ExchangeRequest[] = [];
	const record = (request: ExchangeRequest) => {
		requests.push(structuredClone(request));
		return authority.exchange(request);
	};
	const failed = await replica.synchronize(record);
	expect(expectErr(failed).name).toBe('StorageFailed');
	// Page one committed durably before the crash.
	expect(expectOk(replica.metadata()).lastAppliedAuthoritySequence).toBe(1);

	expectOk(await replica.synchronize(record));
	stopSubscription();
	// The resumed scan starts from the durable watermark: no request ever
	// re-covers the completed first page, and its record installs exactly once.
	const resumed = requests.slice(2);
	expect(resumed.length).toBeGreaterThan(0);
	for (const request of resumed) {
		expect(request.after).toBeGreaterThanOrEqual(1);
	}
	expect(installs.filter((address) => address.includes(VALUE)).length).toBe(1);
	expect(expectOk(replica.metadata()).lastAppliedAuthoritySequence).toBe(3);
	database.close();
});

test('lifetime mismatch wipes old state, remints identity, rebinds, and reacquires at zero', async () => {
	const { database, replica } = setup();
	const authority = createScriptedAuthority();
	expectOk(replica.write(setTheme('old-lifetime')));
	expectOk(
		replica.write({ kind: 'create', ...rowAddress, fields: { title: 'old' } }),
	);
	expectOk(await replica.synchronize(authority.exchange));
	const before = expectOk(replica.metadata());
	expect(before.authorityLifetime).toBe(LIFETIME_A);

	// A pending write that will never be uploaded: Restore abandons it.
	expectOk(replica.write(setTheme('doomed-pending')));
	let resets = 0;
	replica.subscribeReset(() => {
		resets += 1;
	});
	authority.replaceLifetime(LIFETIME_B, [
		{
			kind: 'create',
			namespace: NAMESPACE,
			table: TABLE,
			rowId: 'restored0000000000000000',
			fields: { title: 'restored' },
		},
	]);
	const appliedAfterRestore = authority.appliedChanges;
	expectOk(await replica.synchronize(authority.exchange));
	const after = expectOk(replica.metadata());
	expect(after.authorityLifetime).toBe(LIFETIME_B);
	expect(after.replicaId).not.toBe(before.replicaId);
	expect(after.lastBatchSequence).toBe(0);
	expect(resets).toBe(1);
	// Old-lifetime state and pending work are gone; the successor state is in.
	expect(expectOk(replica.readValue(themeAddress))).toBeUndefined();
	expect(expectOk(replica.readRow(rowAddress))).toBeUndefined();
	expect(
		expectOk(
			replica.readRow({
				namespace: NAMESPACE,
				table: TABLE,
				rowId: 'restored0000000000000000',
			}),
		),
	).toEqual({ title: 'restored' });
	// The doomed pending write was intentionally abandoned, not resubmitted.
	expect(authority.appliedChanges).toBe(appliedAfterRestore);
	database.close();
});

test('same-lifetime progress beyond the authority head is a terminal checkpoint-ahead diagnostic', async () => {
	const { database, replica } = setup();
	const generous = createScriptedAuthority();
	for (let index = 0; index < 5; index += 1) {
		generous.submit(setTheme(`v${index}`));
	}
	expectOk(await replica.synchronize(generous.exchange));
	expect(expectOk(replica.metadata()).lastAppliedAuthoritySequence).toBe(5);

	// Same lifetime, but an authority that never issued those sequences.
	const empty = createScriptedAuthority();
	let exchangeCalls = 0;
	const result = await replica.synchronize((request) => {
		exchangeCalls += 1;
		return empty.exchange(request);
	});
	expect(expectErr(result).name).toBe('CheckpointAhead');
	// Terminal: one refusal, no automatic recovery loop, nothing wiped.
	expect(exchangeCalls).toBe(1);
	expect(expectOk(replica.metadata()).lastAppliedAuthoritySequence).toBe(5);
	expect(expectOk(replica.metadata()).authorityLifetime).toBe(LIFETIME_A);
	database.close();
});

test('a tombstone suppressed by pending work across several batches still wins through the touch', async () => {
	const { database, replica } = setup();
	const authority = createScriptedAuthority();
	expectOk(
		replica.write({ kind: 'create', ...rowAddress, fields: { title: 'mine' } }),
	);
	expectOk(await replica.synchronize(authority.exchange));

	// Another device terminally deletes the row at the authority.
	authority.submit({ kind: 'delete', ...rowAddress });

	// This replica keeps editing offline; a second pending write arrives while
	// the first batch's echo page is being installed, so the touched tombstone
	// is suppressed and the watermark advances past it.
	expectOk(
		replica.write({
			kind: 'update',
			...rowAddress,
			fields: { set: { title: 'edit-one' }, unset: [] },
		}),
	);
	let injected = false;
	expectOk(
		await replica.synchronize((request) => {
			const response = authority.exchange(request);
			if (!injected && request.batch !== undefined) {
				injected = true;
				expectOk(
					replica.write({
						kind: 'update',
						...rowAddress,
						fields: { set: { title: 'edit-two' }, unset: [] },
					}),
				);
			}
			return response;
		}),
	);
	// Both refused edits eventually cleared, and no sequence was lost: the
	// second batch's benign noop re-touched the tombstone, and with no pending
	// work left the ordinary scan installed authority truth.
	expect(expectOk(replica.readRow(rowAddress))).toBeUndefined();
	expect(expectOk(replica.parked())).toEqual([]);
	database.close();
});

test('an inadmissible merged record parks the exact obligation and never reports idle work as synchronized', async () => {
	const { database, replica } = setup();
	const authority = createScriptedAuthority();
	expectOk(
		replica.write({ kind: 'create', ...rowAddress, fields: { seed: 1 } }),
	);
	expectOk(await replica.synchronize(authority.exchange));

	// Another replica grows the authority record close to the record bound.
	const nearBound = 'x'.repeat(500 * 1024);
	authority.submit({
		kind: 'update',
		...rowAddress,
		fields: { set: { bulk: nearBound }, unset: [] },
	});

	// Locally the base is still small, so this write is admissible here but
	// inadmissible against the authority's merged record.
	const wide = 'y'.repeat(16 * 1024);
	expectOk(
		replica.write({
			kind: 'update',
			...rowAddress,
			fields: { set: { extra: wide }, unset: [] },
		}),
	);
	expectOk(replica.write(setTheme('unaffected')));
	const appliedBefore = authority.appliedChanges;
	expectOk(await replica.synchronize(authority.exchange));

	// The refused obligation is parked at its address; the other change in
	// the same envelope was resealed and accepted.
	const parked = expectOk(replica.parked());
	expect(parked).toEqual([
		{ address: { kind: 'row', ...rowAddress }, reason: 'record-bound' },
	]);
	expect(authority.appliedChanges).toBe(appliedBefore + 1);
	expect(expectOk(replica.readValue(themeAddress))).toBe('unaffected');

	// Parked work does not block authoritative truth: the authority's grown
	// record installed over the local optimistic edit.
	expect(expectOk(replica.readRow(rowAddress))).toMatchObject({
		bulk: nearBound,
	});

	// A newer local write to the same address supersedes the parked work.
	expectOk(
		replica.write({
			kind: 'update',
			...rowAddress,
			fields: { set: {}, unset: ['bulk'] },
		}),
	);
	expect(expectOk(replica.parked())).toEqual([]);
	expectOk(await replica.synchronize(authority.exchange));
	expect(expectOk(replica.readRow(rowAddress))).toEqual({ seed: 1 });
	database.close();
});

test('a local write whose merged record exceeds the bound is refused at the API', () => {
	const { database, replica } = setup();
	const oversized = 'x'.repeat(520 * 1024);
	const error = expectErr(
		replica.write({
			kind: 'create',
			...rowAddress,
			fields: { blob: oversized },
		}),
	);
	expect(error.name).toBe('RecordTooLarge');
	expect(expectOk(replica.readRow(rowAddress))).toBeUndefined();
	database.close();
});
