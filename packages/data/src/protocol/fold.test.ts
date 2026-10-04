/**
 * Latest-State Fold Tests
 *
 * Verifies the three-way fold contract: applied records, benign noops that
 * surface the current record for authority touch, and inadmissible merges
 * that must refuse rather than silently clear.
 *
 * Key behaviors:
 * - A row tombstone is terminal within one lifetime; value unset is not
 * - Benign noops and inadmissible merges are different variants
 * - Row and value addresses never collide even with equal member keys
 */
import { describe, expect, test } from 'bun:test';

import { DATA_ADMISSION_LIMITS } from './admission.js';
import { foldChange } from './fold.js';
import type { Change, JsonObject, Record as SyncRecord } from './schemas.js';

const NAMESPACE = 'so.epicenter.fold';
const ROW_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const liveRow = (fields: JsonObject): SyncRecord => ({
	kind: 'row',
	namespace: NAMESPACE,
	table: 'rows',
	rowId: ROW_ID,
	changedSequence: 5,
	fields,
});

const tombstone: SyncRecord = {
	kind: 'row-deleted',
	namespace: NAMESPACE,
	table: 'rows',
	rowId: ROW_ID,
	changedSequence: 6,
};

describe('applied folds', () => {
	test('create, update, delete, set, and unset produce winning records', () => {
		const created = foldChange(
			undefined,
			{
				kind: 'create',
				namespace: NAMESPACE,
				table: 'rows',
				rowId: ROW_ID,
				fields: { title: 'A' },
			},
			7,
		);
		expect(created).toMatchObject({
			kind: 'applied',
			record: { kind: 'row', changedSequence: 7, fields: { title: 'A' } },
		});

		const updated = foldChange(
			liveRow({ title: 'A', old: 1 }),
			{
				kind: 'update',
				namespace: NAMESPACE,
				table: 'rows',
				rowId: ROW_ID,
				fields: { set: { title: 'B' }, unset: ['old'] },
			},
			8,
		);
		expect(updated).toMatchObject({
			kind: 'applied',
			record: { changedSequence: 8, fields: { title: 'B' } },
		});

		const deleted = foldChange(
			liveRow({}),
			{ kind: 'delete', namespace: NAMESPACE, table: 'rows', rowId: ROW_ID },
			9,
		);
		expect(deleted).toMatchObject({
			kind: 'applied',
			record: { kind: 'row-deleted', changedSequence: 9 },
		});

		const set = foldChange(
			undefined,
			{ kind: 'set', namespace: NAMESPACE, value: 'theme', payload: 'dark' },
			10,
		);
		expect(set).toMatchObject({
			kind: 'applied',
			record: { kind: 'value', payload: 'dark', changedSequence: 10 },
		});

		const unset = foldChange(
			{
				kind: 'value',
				namespace: NAMESPACE,
				value: 'theme',
				changedSequence: 10,
				payload: 'dark',
			},
			{ kind: 'unset', namespace: NAMESPACE, value: 'theme' },
			11,
		);
		expect(unset).toMatchObject({
			kind: 'applied',
			record: { kind: 'value-unset', changedSequence: 11 },
		});
	});

	test('value set replaces unset: unset latest state is not terminal', () => {
		const replaced = foldChange(
			{
				kind: 'value-unset',
				namespace: NAMESPACE,
				value: 'theme',
				changedSequence: 4,
			},
			{ kind: 'set', namespace: NAMESPACE, value: 'theme', payload: 'light' },
			12,
		);
		expect(replaced).toMatchObject({
			kind: 'applied',
			record: { kind: 'value', payload: 'light' },
		});
	});
});

describe('benign noops surface the current record', () => {
	test('create over an existing live row is a noop carrying that row', () => {
		const current = liveRow({ title: 'A' });
		expect(
			foldChange(
				current,
				{
					kind: 'create',
					namespace: NAMESPACE,
					table: 'rows',
					rowId: ROW_ID,
					fields: { title: 'stale' },
				},
				7,
			),
		).toEqual({ kind: 'noop', current });
	});

	test('a row tombstone defeats later create, update, and delete', () => {
		const attempts: Change[] = [
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
			{ kind: 'delete', namespace: NAMESPACE, table: 'rows', rowId: ROW_ID },
		];
		for (const change of attempts) {
			expect(foldChange(tombstone, change, 9)).toEqual({
				kind: 'noop',
				current: tombstone,
			});
		}
	});

	test('mutating an absent address is a noop with no current record', () => {
		expect(
			foldChange(
				undefined,
				{
					kind: 'update',
					namespace: NAMESPACE,
					table: 'rows',
					rowId: ROW_ID,
					fields: { set: { title: 'B' }, unset: [] },
				},
				7,
			),
		).toEqual({ kind: 'noop', current: undefined });
		expect(
			foldChange(
				undefined,
				{ kind: 'unset', namespace: NAMESPACE, value: 'theme' },
				7,
			),
		).toEqual({ kind: 'noop', current: undefined });
	});

	test('unset of an unset value is a noop carrying the unset record', () => {
		const current: SyncRecord = {
			kind: 'value-unset',
			namespace: NAMESPACE,
			value: 'theme',
			changedSequence: 3,
		};
		expect(
			foldChange(
				current,
				{ kind: 'unset', namespace: NAMESPACE, value: 'theme' },
				7,
			),
		).toEqual({ kind: 'noop', current });
	});
});

describe('address discrimination', () => {
	test('a value record never folds as the current state of a row change', () => {
		const valueRecord: SyncRecord = {
			kind: 'value',
			namespace: NAMESPACE,
			value: 'rows',
			changedSequence: 5,
			payload: 1,
		};
		// Same namespace and member key, different kind: the create applies.
		expect(
			foldChange(
				valueRecord,
				{
					kind: 'create',
					namespace: NAMESPACE,
					table: 'rows',
					rowId: ROW_ID,
					fields: {},
				},
				7,
			).kind,
		).toBe('applied');
	});

	test('a record from another namespace never folds as current state', () => {
		const foreign: SyncRecord = {
			kind: 'row',
			namespace: 'so.epicenter.other',
			table: 'rows',
			rowId: ROW_ID,
			changedSequence: 5,
			fields: {},
		};
		expect(
			foldChange(
				foreign,
				{
					kind: 'create',
					namespace: NAMESPACE,
					table: 'rows',
					rowId: ROW_ID,
					fields: {},
				},
				7,
			).kind,
		).toBe('applied');
	});
});

describe('inadmissible merged records', () => {
	test('an admissible update that merges above the record bound is inadmissible, not benign', () => {
		const halfBound = 'x'.repeat(
			Math.floor(DATA_ADMISSION_LIMITS.encodedRecordBytes / 2) + 1024,
		);
		const current = liveRow({ first: halfBound });
		const folded = foldChange(
			current,
			{
				kind: 'update',
				namespace: NAMESPACE,
				table: 'rows',
				rowId: ROW_ID,
				fields: { set: { second: halfBound }, unset: [] },
			},
			7,
		);
		expect(folded).toEqual({ kind: 'inadmissible', reason: 'record-bound' });
	});

	test('an oversized create is inadmissible even with no current record', () => {
		const oversized = 'x'.repeat(DATA_ADMISSION_LIMITS.encodedRecordBytes + 1);
		expect(
			foldChange(
				undefined,
				{
					kind: 'create',
					namespace: NAMESPACE,
					table: 'rows',
					rowId: ROW_ID,
					fields: { blob: oversized },
				},
				7,
			),
		).toEqual({ kind: 'inadmissible', reason: 'record-bound' });
	});
});
