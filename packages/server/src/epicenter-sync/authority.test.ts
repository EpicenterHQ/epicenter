/**
 * Epicenter Sync SQLite Authority Tests
 *
 * Verifies the authority's physical format, lifetime binding, single-receipt
 * discipline, durable-watermark paging, whole-envelope inadmissibility
 * refusal, benign-noop touches, terminal deletion cleanup, and storage wall
 * rollback.
 *
 * Key behaviors:
 * - Fresh stores mint one opaque lifetime; unknown formats are refused
 * - Every response carries the active lifetime; mismatch is a refusal
 * - Exact retries reuse one minimal receipt while forks and gaps conflict
 * - An inadmissible merged record refuses the whole envelope before mutation
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { batchDigest, type Change } from '@epicenter/data/protocol';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';

import {
	AUTHORITY_STORAGE_BYTE_CEILING,
	openEpicenterSyncAuthority,
} from './authority.js';

const REPLICA = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const LIFETIME = 'llllllllllllllllllllllll';
const NAMESPACE = 'so.epicenter.tests';
const ROW_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const setValue = (value: string, payload: unknown): Change => ({
	kind: 'set',
	namespace: NAMESPACE,
	value,
	payload: payload as Change extends { payload: infer P } ? P : never,
});

function batch(seq: number, changes: Change[]) {
	return { seq, digest: batchDigest(changes), changes };
}

function setup(options: { pageSize?: number; size?: () => number } = {}) {
	const raw = new Database(':memory:');
	const database = createBunSqliteAdapter(raw);
	const authority = openEpicenterSyncAuthority({
		database,
		pageSize: options.pageSize,
		readDatabaseSize: options.size,
		mintLifetimeId: () => LIFETIME,
	});
	return { raw, database, authority };
}

test('fresh schema mints one lifetime, reopens, and refuses unknown formats without rewrite', () => {
	const { raw, database } = setup();
	expect(
		raw
			.query<{ lifetime_id: string }, []>('SELECT lifetime_id FROM metadata')
			.get()?.lifetime_id,
	).toBe(LIFETIME);
	expect(() => openEpicenterSyncAuthority({ database })).not.toThrow();
	raw.run('UPDATE metadata SET format_version = 99 WHERE singleton = 1');
	expect(() => openEpicenterSyncAuthority({ database })).toThrow(
		'format 99 is not supported',
	);
	expect(
		raw
			.query<{ format_version: number }, []>(
				'SELECT format_version FROM metadata',
			)
			.get()?.format_version,
	).toBe(99);
	raw.close();
});

test('the flat-key format 1 authority store is refused, never migrated', () => {
	const raw = new Database(':memory:');
	for (const table of ['metadata', 'replicas', 'state', 'document_updates']) {
		raw.run(`CREATE TABLE ${table} (unused INTEGER)`);
	}
	raw.run('INSERT INTO metadata VALUES (1)');
	expect(() =>
		openEpicenterSyncAuthority({ database: createBunSqliteAdapter(raw) }),
	).toThrow();
	raw.close();
});

test('a fresh replica binds with a null lifetime and every response carries the active lifetime', () => {
	const { raw, authority } = setup();
	const accepted = authority.exchange({
		replicaId: REPLICA,
		lifetimeId: null,
		after: 0,
		batch: batch(1, [setValue('value', 1)]),
	});
	expect(accepted).toMatchObject({ lifetimeId: LIFETIME });
	const bound = authority.exchange({
		replicaId: REPLICA,
		lifetimeId: LIFETIME,
		after: 0,
	});
	expect(bound).toMatchObject({ lifetimeId: LIFETIME });
	raw.close();
});

test('a superseded lifetime receives a lifetime-mismatch refusal, not malformed input', () => {
	const { raw, authority } = setup();
	const response = authority.exchange({
		replicaId: REPLICA,
		lifetimeId: 'oooooooooooooooooooooooo',
		after: 0,
		batch: batch(1, [setValue('value', 1)]),
	});
	expect(response).toEqual({
		refusal: 'lifetime-mismatch',
		lifetimeId: LIFETIME,
	});
	// Nothing was accepted for the refused lifetime.
	expect(
		raw
			.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM state')
			.get()?.count,
	).toBe(0);
	raw.close();
});

test('same-lifetime progress beyond the head is a checkpoint-ahead refusal, disjoint from mismatch', () => {
	const { raw, authority } = setup();
	authority.exchange({
		replicaId: REPLICA,
		lifetimeId: null,
		after: 0,
		batch: batch(1, [setValue('value', 1)]),
	});
	expect(
		authority.exchange({ replicaId: REPLICA, lifetimeId: LIFETIME, after: 9 }),
	).toEqual({ refusal: 'checkpoint-ahead', lifetimeId: LIFETIME });
	expect(
		authority.exchange({
			replicaId: REPLICA,
			lifetimeId: LIFETIME,
			after: 0,
			through: 9,
		}),
	).toEqual({ refusal: 'checkpoint-ahead', lifetimeId: LIFETIME });
	raw.close();
});

test('exact retry returns one minimal receipt while fork, old batch, and gap conflict', () => {
	const { raw, authority } = setup();
	const first = batch(1, [setValue('value', 1)]);
	const accepted = authority.exchange({
		replicaId: REPLICA,
		lifetimeId: LIFETIME,
		after: 0,
		batch: first,
	});
	expect(accepted).toMatchObject({
		receipt: { seq: 1, digest: first.digest },
	});
	if ('refusal' in accepted) throw new Error(accepted.refusal);
	expect(Object.keys(accepted.receipt ?? {}).sort()).toEqual(['digest', 'seq']);
	expect(
		authority.exchange({
			replicaId: REPLICA,
			lifetimeId: LIFETIME,
			after: 0,
			batch: first,
		}),
	).toEqual(accepted);
	const fork = batch(1, [setValue('value', 2)]);
	expect(
		authority.exchange({
			replicaId: REPLICA,
			lifetimeId: LIFETIME,
			after: 0,
			batch: fork,
		}),
	).toEqual({ refusal: 'batch-conflict', lifetimeId: LIFETIME });
	expect(
		authority.exchange({
			replicaId: REPLICA,
			lifetimeId: LIFETIME,
			after: 0,
			batch: batch(3, [setValue('other', 3)]),
		}),
	).toEqual({ refusal: 'batch-conflict', lifetimeId: LIFETIME });
	expect(
		raw
			.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM state')
			.get()?.count,
	).toBe(1);
	// The replica row is exactly the minimal receipt: no receipt_sequence.
	expect(
		raw.query<Record<string, unknown>, []>('SELECT * FROM replicas').get(),
	).toEqual({
		replica_id: REPLICA,
		accepted_batch: 1,
		request_digest: first.digest,
	});
	raw.close();
});

test('durable-watermark pages are ordered, bounded, and continue with a fixed through', () => {
	const { raw, authority } = setup({ pageSize: 1 });
	const first = authority.exchange({
		replicaId: REPLICA,
		lifetimeId: null,
		after: 0,
		batch: batch(1, [setValue('a', 1), setValue('b', 2), setValue('c', 3)]),
	});
	if ('refusal' in first) throw new Error(first.refusal);
	expect(first.records).toHaveLength(1);
	expect(first.through).toBe(3);
	expect(first.more).toBe(true);
	// The replica advanced its durable watermark to the last returned
	// sequence and continues with the same through.
	const second = authority.exchange({
		replicaId: REPLICA,
		lifetimeId: LIFETIME,
		after: first.records[0]?.changedSequence ?? 0,
		through: first.through,
	});
	if ('refusal' in second) throw new Error(second.refusal);
	expect(second.through).toBe(first.through);
	expect(second.records[0]?.changedSequence).toBe(2);
	expect(second.more).toBe(true);
	raw.close();
});

test('record replaced above through waits for the next exchange without skipping peers', () => {
	const { raw, authority } = setup({ pageSize: 1 });
	const first = authority.exchange({
		replicaId: REPLICA,
		lifetimeId: null,
		after: 0,
		batch: batch(1, [setValue('a', 'a1'), setValue('b', 'b1')]),
	});
	if ('refusal' in first || !first.more) {
		throw new Error('Expected a continuing first page');
	}
	authority.exchange({
		replicaId: REPLICA,
		lifetimeId: LIFETIME,
		after: 0,
		batch: batch(2, [setValue('a', 'a2')]),
	});
	const remainder = authority.exchange({
		replicaId: REPLICA,
		lifetimeId: LIFETIME,
		after: first.records[0]?.changedSequence ?? 0,
		through: first.through,
	});
	if ('refusal' in remainder) throw new Error(remainder.refusal);
	expect(
		remainder.records.map((record) =>
			'value' in record ? record.value : undefined,
		),
	).toEqual(['b']);
	const next = authority.exchange({
		replicaId: REPLICA,
		lifetimeId: LIFETIME,
		after: first.through,
	});
	if ('refusal' in next) throw new Error(next.refusal);
	expect(next.records).toEqual([
		{
			kind: 'value',
			namespace: NAMESPACE,
			value: 'a',
			changedSequence: 3,
			payload: 'a2',
		},
	]);
	raw.close();
});

test('a benign noop touches the current record once per batch and exact retry never touches twice', () => {
	const { raw, authority } = setup();
	authority.exchange({
		replicaId: REPLICA,
		lifetimeId: null,
		after: 0,
		batch: batch(1, [
			{
				kind: 'create',
				namespace: NAMESPACE,
				table: 'rows',
				rowId: ROW_ID,
				fields: { title: 'live' },
			},
			{ kind: 'delete', namespace: NAMESPACE, table: 'rows', rowId: ROW_ID },
		]),
	});
	const tombstoneSequence = raw
		.query<{ changed_sequence: number }, []>(
			'SELECT changed_sequence FROM state',
		)
		.get()?.changed_sequence;
	if (tombstoneSequence === undefined) throw new Error('Expected a tombstone');

	// A stale offline replica uploads two edits to the tombstoned address in
	// one batch: one touch, not two.
	const stale = batch(1, [
		{
			kind: 'create',
			namespace: NAMESPACE,
			table: 'rows',
			rowId: ROW_ID,
			fields: { resurrect: true },
		},
		{
			kind: 'update',
			namespace: NAMESPACE,
			table: 'rows',
			rowId: ROW_ID,
			fields: { set: { resurrect: true }, unset: [] },
		},
	]);
	const staleReplica = 'ssssssssssssssssssssssss';
	const touched = authority.exchange({
		replicaId: staleReplica,
		lifetimeId: LIFETIME,
		after: tombstoneSequence,
		batch: stale,
	});
	if ('refusal' in touched) throw new Error(touched.refusal);
	// The touch moved the tombstone into the stale replica's scan window, so
	// the same exchange that cleared its optimism re-delivers authority truth.
	expect(touched.records).toEqual([
		{
			kind: 'row-deleted',
			namespace: NAMESPACE,
			table: 'rows',
			rowId: ROW_ID,
			changedSequence: tombstoneSequence + 1,
		},
	]);

	// Exact retry returns the stored receipt and does not touch again.
	const retried = authority.exchange({
		replicaId: staleReplica,
		lifetimeId: LIFETIME,
		after: tombstoneSequence + 1,
		batch: stale,
	});
	if ('refusal' in retried) throw new Error(retried.refusal);
	expect(retried.records).toEqual([]);
	expect(
		raw
			.query<{ changed_sequence: number }, []>(
				'SELECT changed_sequence FROM state',
			)
			.get()?.changed_sequence,
	).toBe(tombstoneSequence + 1);
	raw.close();
});

test('an inadmissible merged record refuses the whole envelope before any mutation', () => {
	const { raw, authority } = setup();
	const nearBound = 'x'.repeat(500 * 1024);
	authority.exchange({
		replicaId: REPLICA,
		lifetimeId: null,
		after: 0,
		batch: batch(1, [
			{
				kind: 'create',
				namespace: NAMESPACE,
				table: 'rows',
				rowId: ROW_ID,
				fields: { bulk: nearBound },
			},
		]),
	});
	const snapshotState = () => ({
		stateCount: raw
			.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM state')
			.get()?.count,
		nextSequence: raw
			.query<{ next_sequence: number }, []>(
				'SELECT next_sequence FROM metadata',
			)
			.get()?.next_sequence,
		replicas: raw
			.query<Record<string, unknown>, []>(
				'SELECT * FROM replicas ORDER BY replica_id',
			)
			.all(),
	});
	const before = snapshotState();

	// Change 0 is fine; change 1 merges above the record bound. The whole
	// envelope refuses, identifying the offending index, and nothing mutates.
	const offending = batch(2, [
		setValue('fine', 'ok'),
		{
			kind: 'update',
			namespace: NAMESPACE,
			table: 'rows',
			rowId: ROW_ID,
			fields: { set: { extra: 'y'.repeat(16 * 1024) }, unset: [] },
		},
	]);
	const refused = authority.exchange({
		replicaId: REPLICA,
		lifetimeId: LIFETIME,
		after: 0,
		batch: offending,
	});
	expect(refused).toEqual({
		refusal: 'change-inadmissible',
		lifetimeId: LIFETIME,
		seq: 2,
		digest: offending.digest,
		changeIndex: 1,
		reason: 'record-bound',
	});
	expect(snapshotState()).toEqual(before);
	// A lost refusal is safe: the exact retry recomputes the same refusal.
	expect(
		authority.exchange({
			replicaId: REPLICA,
			lifetimeId: LIFETIME,
			after: 0,
			batch: offending,
		}),
	).toEqual(refused);
	// Resealing the same sequence without the refused change is accepted.
	const resealed = batch(2, [setValue('fine', 'ok')]);
	expect(
		authority.exchange({
			replicaId: REPLICA,
			lifetimeId: LIFETIME,
			after: 0,
			batch: resealed,
		}),
	).toMatchObject({ receipt: { seq: 2, digest: resealed.digest } });
	raw.close();
});

test('sequential changes to one address inside a batch fold against the staged overlay', () => {
	const { raw, authority } = setup();
	const response = authority.exchange({
		replicaId: REPLICA,
		lifetimeId: null,
		after: 0,
		batch: batch(1, [
			{
				kind: 'create',
				namespace: NAMESPACE,
				table: 'rows',
				rowId: ROW_ID,
				fields: { step: 1 },
			},
			{
				kind: 'update',
				namespace: NAMESPACE,
				table: 'rows',
				rowId: ROW_ID,
				fields: { set: { step: 2 }, unset: [] },
			},
		]),
	});
	if ('refusal' in response) throw new Error(response.refusal);
	expect(response.records).toEqual([
		{
			kind: 'row',
			namespace: NAMESPACE,
			table: 'rows',
			rowId: ROW_ID,
			changedSequence: 2,
			fields: { step: 2 },
		},
	]);
	raw.close();
});

test('terminal row deletion removes document updates in the acceptance transaction', () => {
	const { raw, authority } = setup();
	authority.exchange({
		replicaId: REPLICA,
		lifetimeId: null,
		after: 0,
		batch: batch(1, [
			{
				kind: 'create',
				namespace: NAMESPACE,
				table: 'rows',
				rowId: ROW_ID,
				fields: { title: 'live' },
			},
		]),
	});
	raw.run('INSERT INTO document_updates VALUES (?, ?, ?, 1, ?)', [
		NAMESPACE,
		'rows',
		ROW_ID,
		new Uint8Array([1]),
	]);
	authority.exchange({
		replicaId: REPLICA,
		lifetimeId: LIFETIME,
		after: 1,
		batch: batch(2, [
			{ kind: 'delete', namespace: NAMESPACE, table: 'rows', rowId: ROW_ID },
		]),
	});
	expect(
		raw
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM document_updates',
			)
			.get()?.count,
	).toBe(0);
	expect(
		raw.query<{ status: string }, []>('SELECT status FROM state').get()?.status,
	).toBe('deleted');
	raw.close();
});

test('storage-limit refusal leaves no replica, state, or sequence allocation', () => {
	const { raw, authority } = setup({
		size: () => AUTHORITY_STORAGE_BYTE_CEILING,
	});
	const response = authority.exchange({
		replicaId: REPLICA,
		lifetimeId: LIFETIME,
		after: 0,
		batch: batch(1, [setValue('value', 'blocked')]),
	});
	expect(response).toEqual({ refusal: 'storage-limit', lifetimeId: LIFETIME });
	expect(
		raw
			.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM replicas')
			.get()?.count,
	).toBe(0);
	expect(
		raw
			.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM state')
			.get()?.count,
	).toBe(0);
	expect(
		raw
			.query<{ next_sequence: number }, []>(
				'SELECT next_sequence FROM metadata',
			)
			.get()?.next_sequence,
	).toBe(1);
	raw.close();
});

test('invalid request shape and mismatched digest throw without mutation', () => {
	const { raw, authority } = setup();
	expect(() =>
		authority.exchange({ replicaId: REPLICA, lifetimeId: LIFETIME, after: -1 }),
	).toThrow('Invalid data protocol exchange request');
	// The flat qualified-key request shape is malformed input, not a refusal.
	expect(() =>
		authority.exchange({
			replicaId: REPLICA,
			lifetimeId: LIFETIME,
			after: 0,
			batch: batch(1, [
				{
					kind: 'set',
					key: 'so.epicenter.tests.value',
					value: 1,
				} as unknown as Change,
			]),
		}),
	).toThrow('Invalid data protocol exchange request');
	expect(() =>
		authority.exchange({
			replicaId: REPLICA,
			lifetimeId: LIFETIME,
			after: 0,
			batch: {
				...batch(1, [setValue('value', 1)]),
				digest: '0'.repeat(64),
			},
		}),
	).toThrow('Batch digest does not match its changes');
	expect(
		raw
			.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM state')
			.get()?.count,
	).toBe(0);
	raw.close();
});
