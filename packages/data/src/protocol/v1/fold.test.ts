/**
 * Scalar V1 Authority Fold Tests
 *
 * Exercises every transition of the pure authority fold: one current fact plus
 * one intent yields the next fact, or reports the current fact unchanged so no
 * sequence is spent.
 *
 * Key behaviors:
 * - Row-present is upsert-patch: it folds over the live row or an empty base
 * - Independent top-level fields compose; `set` is applied before `unset`
 * - A terminal row tombstone dominates a later row-present intent
 * - Row-absent installs or preserves the tombstone; value-absent is reversible
 * - Idempotent transitions report `unchanged`
 */
import { describe, expect, test } from 'bun:test';

import {
	type Fact,
	foldIntent,
	type Intent,
	type JsonObject,
	type JsonValue,
	type RowAddress,
	type ValueAddress,
} from './index.js';

const ROW: RowAddress = {
	kind: 'row',
	namespace: 'so.epicenter.notes',
	table: 'recordings',
	rowId: 'abc123def456ghi789jkl012',
};
const VALUE: ValueAddress = {
	kind: 'value',
	namespace: 'so.epicenter.settings',
	value: 'language',
};

const rowPresent = (fields: JsonObject, sequence = 1): Fact => ({
	address: ROW,
	sequence,
	presence: 'present',
	fields,
});
const rowAbsent = (sequence = 2): Fact => ({
	address: ROW,
	sequence,
	presence: 'absent',
});
const valuePresent = (content: JsonValue, sequence = 1): Fact => ({
	address: VALUE,
	sequence,
	presence: 'present',
	content,
});
const valueAbsent = (sequence = 2): Fact => ({
	address: VALUE,
	sequence,
	presence: 'absent',
});

const rowPatch = (set: JsonObject, unset: string[] = []): Intent => ({
	address: ROW,
	presence: 'present',
	set,
	unset,
});
const rowDelete = (): Intent => ({ address: ROW, presence: 'absent' });
const valueSet = (content: JsonValue): Intent => ({
	address: VALUE,
	presence: 'present',
	content,
});
const valueUnset = (): Intent => ({ address: VALUE, presence: 'absent' });

describe('row-present upsert-patch', () => {
	test('over no fact installs a present row from an empty base', () => {
		expect(foldIntent(undefined, rowPatch({ title: 'A' }), 5)).toEqual({
			kind: 'changed',
			fact: rowPresent({ title: 'A' }, 5),
		});
	});

	test('over no fact with an empty patch installs a present empty row', () => {
		expect(foldIntent(undefined, rowPatch({}), 5)).toEqual({
			kind: 'changed',
			fact: rowPresent({}, 5),
		});
	});

	test('independent top-level fields compose over the live row', () => {
		const afterFirst = foldIntent(undefined, rowPatch({ title: 'A' }), 1);
		expect(afterFirst.kind).toBe('changed');
		const base = afterFirst.kind === 'changed' ? afterFirst.fact : undefined;
		expect(foldIntent(base, rowPatch({ status: 'open' }), 2)).toEqual({
			kind: 'changed',
			fact: rowPresent({ title: 'A', status: 'open' }, 2),
		});
	});

	test('applies set before unset', () => {
		const folded = foldIntent(
			rowPresent({ title: 'A', keep: true }),
			rowPatch({ title: 'B', remove: 'set-first' }, ['remove']),
			9,
		);
		expect(folded).toEqual({
			kind: 'changed',
			fact: rowPresent({ title: 'B', keep: true }, 9),
		});
	});

	test('an idempotent patch over the live row is unchanged', () => {
		expect(
			foldIntent(rowPresent({ title: 'A' }), rowPatch({ title: 'A' }), 9),
		).toEqual({
			kind: 'unchanged',
		});
		expect(foldIntent(rowPresent({ title: 'A' }), rowPatch({}), 9)).toEqual({
			kind: 'unchanged',
		});
	});

	test('over a terminal tombstone the row does not resurrect', () => {
		expect(foldIntent(rowAbsent(), rowPatch({ title: 'A' }), 9)).toEqual({
			kind: 'unchanged',
		});
	});
});

describe('row-absent tombstone', () => {
	test('over a live row installs the tombstone', () => {
		expect(foldIntent(rowPresent({ title: 'A' }), rowDelete(), 9)).toEqual({
			kind: 'changed',
			fact: rowAbsent(9),
		});
	});
	test('over no fact installs the tombstone', () => {
		expect(foldIntent(undefined, rowDelete(), 9)).toEqual({
			kind: 'changed',
			fact: rowAbsent(9),
		});
	});
	test('over an existing tombstone is unchanged', () => {
		expect(foldIntent(rowAbsent(), rowDelete(), 9)).toEqual({
			kind: 'unchanged',
		});
	});
});

describe('value present and reversible absence', () => {
	test('set replaces over no fact, live, and unset', () => {
		for (const current of [undefined, valuePresent('dark'), valueAbsent()]) {
			expect(foldIntent(current, valueSet('light'), 7)).toEqual({
				kind: 'changed',
				fact: valuePresent('light', 7),
			});
		}
	});
	test('an idempotent set is unchanged', () => {
		expect(foldIntent(valuePresent('dark'), valueSet('dark'), 7)).toEqual({
			kind: 'unchanged',
		});
	});
	test('unset over a live value installs a reversible absence a later set revives', () => {
		expect(foldIntent(valuePresent('dark'), valueUnset(), 7)).toEqual({
			kind: 'changed',
			fact: valueAbsent(7),
		});
		expect(foldIntent(valueAbsent(), valueSet('again'), 8)).toEqual({
			kind: 'changed',
			fact: valuePresent('again', 8),
		});
	});
	test('unset over no fact installs absence; over existing absence is unchanged', () => {
		expect(foldIntent(undefined, valueUnset(), 7)).toEqual({
			kind: 'changed',
			fact: valueAbsent(7),
		});
		expect(foldIntent(valueAbsent(), valueUnset(), 8)).toEqual({
			kind: 'unchanged',
		});
	});
});
