/**
 * Scalar V1 Fact and Intent Schema Tests
 *
 * Proves schema closure and hostile-input rejection for the four fact shapes
 * and four intent shapes. Presence and address kind are independent axes: an
 * empty object is a present row and `null` is a present value, so absence is
 * never inferred from an empty or null payload.
 *
 * Key behaviors:
 * - All four facts and all four intents parse
 * - Shapes are closed: extra or mismatched properties reject
 * - Legacy exchange vocabulary (create/update kinds, changedSequence, digest)
 *   is rejected, not silently tolerated
 * - Row create and update both express as one row-present patch
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
	encodedFactBytes,
	type Fact,
	type Intent,
	parseFact,
	parseIntent,
	type RowAddress,
	type ValueAddress,
} from './index.js';
import { makeLimits } from './kernel.test-support.js';

const LIMITS = makeLimits();
const loneSurrogate = String.fromCharCode(0xd800);

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

describe('four fact shapes', () => {
	const facts: Array<[string, Fact]> = [
		[
			'row present',
			{
				address: ROW,
				sequence: 1,
				presence: 'present',
				fields: { title: 'A' },
			},
		],
		[
			'row present empty object',
			{ address: ROW, sequence: 1, presence: 'present', fields: {} },
		],
		['row absent tombstone', { address: ROW, sequence: 2, presence: 'absent' }],
		[
			'value present null',
			{ address: VALUE, sequence: 1, presence: 'present', content: null },
		],
		['value absent unset', { address: VALUE, sequence: 2, presence: 'absent' }],
	];
	for (const [name, fact] of facts) {
		test(`${name} parses`, () => {
			expect(expectOk(parseFact(fact, LIMITS))).toEqual(fact);
		});
	}
});

describe('four intent shapes', () => {
	const intents: Array<[string, Intent]> = [
		[
			'row present patch',
			{
				address: ROW,
				presence: 'present',
				set: { title: 'A' },
				unset: ['old'],
			},
		],
		[
			'row present create-as-patch',
			{ address: ROW, presence: 'present', set: {}, unset: [] },
		],
		['row absent delete', { address: ROW, presence: 'absent' }],
		[
			'value present set',
			{ address: VALUE, presence: 'present', content: 'en' },
		],
		['value absent unset', { address: VALUE, presence: 'absent' }],
	];
	for (const [name, intent] of intents) {
		test(`${name} parses`, () => {
			expect(expectOk(parseIntent(intent, LIMITS))).toEqual(intent);
		});
	}
});

describe('fact hostile input', () => {
	test('rejects sequence zero and non-positive sequence', () => {
		expectErr(
			parseFact({ address: ROW, sequence: 0, presence: 'absent' }, LIMITS),
		);
		expectErr(
			parseFact({ address: ROW, sequence: -1, presence: 'absent' }, LIMITS),
		);
	});
	test('rejects a present row carrying value content', () => {
		expectErr(
			parseFact(
				{ address: ROW, sequence: 1, presence: 'present', content: 1 },
				LIMITS,
			),
		);
	});
	test('rejects an absent fact carrying a payload', () => {
		expectErr(
			parseFact(
				{ address: ROW, sequence: 1, presence: 'absent', fields: {} },
				LIMITS,
			),
		);
	});
	test('rejects the legacy changedSequence field', () => {
		expectErr(
			parseFact(
				{ address: ROW, changedSequence: 1, presence: 'present', fields: {} },
				LIMITS,
			),
		);
	});
	test('admits a fact at exactly the encoded ceiling and rejects one byte over', () => {
		const atFact: Fact = {
			address: VALUE,
			sequence: 1,
			presence: 'present',
			content: 'x'.repeat(20),
		};
		// Tight limit set to the fact's exact encoded size, then parsed under it.
		const size = encodedFactBytes(atFact);
		const tight = makeLimits({ maxEncodedFactBytes: size });
		expect(expectOk(parseFact(atFact, tight))).toEqual(atFact);
		const overFact: Fact = { ...atFact, content: 'x'.repeat(21) };
		expect(encodedFactBytes(overFact)).toBe(size + 1);
		expectErr(parseFact(overFact, tight));
	});
});

describe('intent hostile input', () => {
	test('rejects legacy typed verbs that carried a kind discriminant', () => {
		expectErr(
			parseIntent(
				{
					kind: 'create',
					key: 'so.epicenter.notes.recordings',
					rowId: ROW.rowId,
					fields: {},
				},
				LIMITS,
			),
		);
		expectErr(
			parseIntent({ kind: 'update', address: ROW, set: {}, unset: [] }, LIMITS),
		);
	});
	test('rejects a row patch whose set and unset overlap', () => {
		expectErr(
			parseIntent(
				{
					address: ROW,
					presence: 'present',
					set: { title: 'A' },
					unset: ['title'],
				},
				LIMITS,
			),
		);
	});
	test('rejects a value intent with an extra field, closing the shape', () => {
		expectErr(
			parseIntent(
				{ address: VALUE, presence: 'present', content: 'en', extra: 1 },
				LIMITS,
			),
		);
	});
	test('rejects a non-JSON payload', () => {
		expectErr(
			parseIntent(
				{ address: VALUE, presence: 'present', content: Number.NaN },
				LIMITS,
			),
		);
	});
});

describe('no legacy exchange vocabulary', () => {
	test('a fact rejects through, position, digest, and receipt fields', () => {
		for (const noise of [
			'through',
			'position',
			'digest',
			'receipt',
			'next',
			'cursor',
		]) {
			expectErr(
				parseFact(
					{ address: ROW, sequence: 1, presence: 'absent', [noise]: 1 },
					LIMITS,
				),
			);
		}
	});
});

describe('non-JSON payload shapes are rejected', () => {
	const present = (content: unknown): unknown => ({
		address: VALUE,
		presence: 'present',
		content,
	});

	test('a lone surrogate in a value payload is rejected', () => {
		expectErr(parseIntent(present(loneSurrogate), LIMITS));
	});

	test('a lone surrogate in a field key is rejected', () => {
		expectErr(
			parseIntent(
				{
					address: ROW,
					presence: 'present',
					set: { [loneSurrogate]: 'x' },
					unset: [],
				},
				LIMITS,
			),
		);
	});

	test('a lone surrogate in a fact string payload is rejected', () => {
		expectErr(
			parseFact(
				{
					address: VALUE,
					sequence: 1,
					presence: 'present',
					content: loneSurrogate,
				},
				LIMITS,
			),
		);
	});

	test('a sparse array payload is rejected', () => {
		const sparse = [1, 2, 3];
		delete sparse[1]; // introduce a hole without a sparse literal
		expectErr(parseIntent(present(sparse), LIMITS));
	});

	test('an array with an extra own property is rejected', () => {
		const array: unknown[] = [1, 2];
		(array as unknown as Record<string, unknown>).extra = 3;
		expectErr(parseIntent(present(array), LIMITS));
	});

	test('a symbol-keyed payload object is rejected', () => {
		const object: Record<string, unknown> = { a: 1 };
		(object as Record<symbol, unknown>)[Symbol('s')] = 2;
		expectErr(parseIntent(present(object), LIMITS));
	});

	test('an accessor property in a payload object is rejected', () => {
		const object = {};
		Object.defineProperty(object, 'a', { get: () => 1, enumerable: true });
		expectErr(parseIntent(present(object), LIMITS));
	});

	test('a non-enumerable property in a payload object is rejected', () => {
		const object = {};
		Object.defineProperty(object, 'a', {
			value: 1,
			enumerable: false,
			configurable: true,
		});
		expectErr(parseIntent(present(object), LIMITS));
	});

	test('a class instance payload is rejected', () => {
		class Point {
			x = 1;
		}
		expectErr(parseIntent(present(new Point()), LIMITS));
	});

	test('an exotic property on the intent object itself is rejected without throwing', () => {
		const base: Intent = { address: VALUE, presence: 'present', content: 'en' };
		const withSymbol = { ...base };
		(withSymbol as Record<symbol, unknown>)[Symbol('s')] = 1;
		expectErr(parseIntent(withSymbol, LIMITS));
		const withAccessor = { ...base };
		Object.defineProperty(withAccessor, 'sneak', {
			get: () => 1,
			enumerable: true,
		});
		expectErr(parseIntent(withAccessor, LIMITS));
	});

	test('an exotic property on the fact object itself is rejected without throwing', () => {
		const base: Fact = {
			address: VALUE,
			sequence: 1,
			presence: 'present',
			content: 'en',
		};
		const withHidden = { ...base };
		Object.defineProperty(withHidden, 'sneak', {
			value: 1,
			enumerable: false,
		});
		expectErr(parseFact(withHidden, LIMITS));
	});
});

describe('absent intent must be able to install its fact', () => {
	test('rejects an absent intent whose max-sequence fact exceeds the ceiling', () => {
		const tiny = makeLimits({ maxEncodedFactBytes: 100 });
		// The row absent fact carries a full address and a max sequence, over 100 bytes.
		expectErr(parseIntent({ address: ROW, presence: 'absent' }, tiny));
	});

	test('admits an absent intent whose fact fits the ceiling', () => {
		expectOk(parseIntent({ address: ROW, presence: 'absent' }, LIMITS));
	});
});
