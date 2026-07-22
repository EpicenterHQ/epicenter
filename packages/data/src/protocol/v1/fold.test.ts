/**
 * Scalar V1 Authority Fold Tests
 *
 * Exercises every transition of the pure authority fold: one current fact plus
 * one operation yields the next fact, reports the current fact unchanged so no
 * sequence is spent, or refuses a patch over a live non-object base.
 *
 * Key behaviors:
 * - Absorption first: a stored tombstone settles every operation as
 *   superseded, before any payload or operation-specific logic
 * - Patch is upsert: it folds over the live payload or an empty base
 * - Independent top-level fields compose; set and unset are disjoint
 * - A patch over a live non-object base is refused as patch-base-not-object
 * - Unset is reversible: a later replace or patch resurrects the record
 * - Idempotent transitions report `unchanged`
 */
import { describe, expect, test } from 'bun:test';

import {
	type Fact,
	foldIntent,
	type Intent,
	type JsonObject,
	type JsonValue,
	type RecordAddress,
} from './index.js';

const RECORD: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'recordings',
	recordKey: 'abc123def456ghi789jkl012',
};

const live = (payload: JsonValue, sequence = 1): Fact => ({
	address: RECORD,
	sequence,
	state: 'live',
	payload,
});
const tombstone = (sequence = 2): Fact => ({
	address: RECORD,
	sequence,
	state: 'tombstone',
});
const unsetFact = (sequence = 2): Fact => ({
	address: RECORD,
	sequence,
	state: 'unset',
});

const patch = (set: JsonObject, unset: string[] = []): Intent => ({
	address: RECORD,
	op: 'patch',
	set,
	unset,
});
const replace = (value: JsonValue): Intent => ({
	address: RECORD,
	op: 'replace',
	value,
});
const deleteOp = (): Intent => ({ address: RECORD, op: 'tombstone' });
const unsetOp = (): Intent => ({ address: RECORD, op: 'unset' });

describe('patch is upsert', () => {
	test('over no fact installs a live record from an empty base', () => {
		expect(foldIntent(undefined, patch({ title: 'A' }), 5)).toEqual({
			kind: 'changed',
			fact: live({ title: 'A' }, 5),
		});
	});

	test('over no fact with an empty patch installs a live empty object', () => {
		expect(foldIntent(undefined, patch({}), 5)).toEqual({
			kind: 'changed',
			fact: live({}, 5),
		});
	});

	test('over a reversible unset folds over an empty base', () => {
		expect(foldIntent(unsetFact(), patch({ title: 'A' }), 5)).toEqual({
			kind: 'changed',
			fact: live({ title: 'A' }, 5),
		});
	});

	test('independent top-level fields compose over the live payload', () => {
		const afterFirst = foldIntent(undefined, patch({ title: 'A' }), 1);
		expect(afterFirst.kind).toBe('changed');
		const base = afterFirst.kind === 'changed' ? afterFirst.fact : undefined;
		expect(foldIntent(base, patch({ status: 'open' }), 2)).toEqual({
			kind: 'changed',
			fact: live({ title: 'A', status: 'open' }, 2),
		});
	});

	test('set and unset apply as one disjoint field patch', () => {
		const folded = foldIntent(
			live({ title: 'A', keep: true, remove: 'x' }),
			patch({ title: 'B' }, ['remove']),
			9,
		);
		expect(folded).toEqual({
			kind: 'changed',
			fact: live({ title: 'B', keep: true }, 9),
		});
	});

	test('unknown fields written by another Lens survive a patch', () => {
		expect(
			foldIntent(
				live({ title: 'A', unknownField: [1, 2] }),
				patch({ title: 'B' }),
				9,
			),
		).toEqual({
			kind: 'changed',
			fact: live({ title: 'B', unknownField: [1, 2] }, 9),
		});
	});

	test('an idempotent patch over the live payload is unchanged', () => {
		expect(foldIntent(live({ title: 'A' }), patch({ title: 'A' }), 9)).toEqual({
			kind: 'unchanged',
		});
		expect(foldIntent(live({ title: 'A' }), patch({}), 9)).toEqual({
			kind: 'unchanged',
		});
	});

	test('over a live non-object base is refused as patch-base-not-object', () => {
		for (const payload of ['scalar', 0, false, null, [1, 2]] as JsonValue[]) {
			expect(foldIntent(live(payload), patch({ title: 'A' }), 9)).toEqual({
				kind: 'refused',
				code: 'patch-base-not-object',
			});
		}
	});
});

describe('replace', () => {
	test('replaces over no fact, live, and unset', () => {
		for (const current of [undefined, live('dark'), unsetFact()]) {
			expect(foldIntent(current, replace('light'), 7)).toEqual({
				kind: 'changed',
				fact: live('light', 7),
			});
		}
	});
	test('replaces a live object with a scalar and back', () => {
		expect(foldIntent(live({ a: 1 }), replace(5), 7)).toEqual({
			kind: 'changed',
			fact: live(5, 7),
		});
		expect(foldIntent(live(5), replace({ a: 1 }), 8)).toEqual({
			kind: 'changed',
			fact: live({ a: 1 }, 8),
		});
	});
	test('an idempotent replace is unchanged', () => {
		expect(foldIntent(live('dark'), replace('dark'), 7)).toEqual({
			kind: 'unchanged',
		});
	});
	test('null is an ordinary live payload, not absence', () => {
		expect(foldIntent(live('dark'), replace(null), 7)).toEqual({
			kind: 'changed',
			fact: live(null, 7),
		});
	});
});

describe('tombstone is terminal, absorption evaluated first', () => {
	test('over a live record installs the tombstone', () => {
		expect(foldIntent(live({ title: 'A' }), deleteOp(), 9)).toEqual({
			kind: 'changed',
			fact: tombstone(9),
		});
	});
	test('over no fact installs the tombstone', () => {
		expect(foldIntent(undefined, deleteOp(), 9)).toEqual({
			kind: 'changed',
			fact: tombstone(9),
		});
	});
	test('over a reversible unset installs the tombstone', () => {
		expect(foldIntent(unsetFact(), deleteOp(), 9)).toEqual({
			kind: 'changed',
			fact: tombstone(9),
		});
	});
	test('every operation over an existing tombstone is unchanged', () => {
		for (const op of [
			patch({ title: 'A' }),
			replace('resurrect'),
			deleteOp(),
			unsetOp(),
		]) {
			expect(foldIntent(tombstone(), op, 9)).toEqual({ kind: 'unchanged' });
		}
	});
	test('absorption is checked before the patch base: a tombstone never refuses', () => {
		// If payload logic ran first, a patch would probe the (absent) base. The
		// tombstone must absorb before any payload inspection.
		expect(foldIntent(tombstone(), patch({ a: 1 }, ['b']), 9)).toEqual({
			kind: 'unchanged',
		});
	});
});

describe('unset is reversible absence', () => {
	test('unset over a live record installs an absence a later replace revives', () => {
		expect(foldIntent(live('dark'), unsetOp(), 7)).toEqual({
			kind: 'changed',
			fact: unsetFact(7),
		});
		expect(foldIntent(unsetFact(7), replace('again'), 8)).toEqual({
			kind: 'changed',
			fact: live('again', 8),
		});
	});
	test('unset over no fact installs absence; over existing absence is unchanged', () => {
		expect(foldIntent(undefined, unsetOp(), 7)).toEqual({
			kind: 'changed',
			fact: unsetFact(7),
		});
		expect(foldIntent(unsetFact(), unsetOp(), 8)).toEqual({
			kind: 'unchanged',
		});
	});
});
