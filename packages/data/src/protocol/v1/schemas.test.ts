/**
 * Scalar V1 Fact and Operation Schema Tests
 *
 * Proves schema closure and hostile-input rejection for the one fact shape and
 * the four operations. The stored state, not a caller species, carries the
 * meaning of absence: an empty object and `null` are ordinary live payloads,
 * so absence is never inferred from a payload.
 *
 * Key behaviors:
 * - The three fact states and all four operations parse
 * - `payload` is present exactly when the fact state is live
 * - Shapes are closed: extra or mismatched properties reject
 * - Legacy kinded vocabulary (row/value kinds, presence axes, changedSequence,
 *   digest) is rejected, not silently tolerated
 * - Table create and update both express as one patch
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
	encodedFactBytes,
	type Fact,
	type Intent,
	parseFact,
	parseIntent,
	type RecordAddress,
} from './index.js';
import { makeLimits } from './kernel.test-support.js';

const LIMITS = makeLimits();
const loneSurrogate = String.fromCharCode(0xd800);

const RECORD: RecordAddress = {
	namespace: 'so.epicenter.notes',
	collection: 'recordings',
	recordKey: 'abc123def456ghi789jkl012',
};
const VALUE: RecordAddress = {
	namespace: 'so.epicenter.whispering',
	collection: 'settings',
	recordKey: 'language',
};

describe('one fact shape, three states', () => {
	const facts: Array<[string, Fact]> = [
		[
			'live object payload',
			{ address: RECORD, sequence: 1, state: 'live', payload: { title: 'A' } },
		],
		[
			'live empty object payload',
			{ address: RECORD, sequence: 1, state: 'live', payload: {} },
		],
		[
			'live null payload',
			{ address: VALUE, sequence: 1, state: 'live', payload: null },
		],
		[
			'live scalar payload',
			{ address: VALUE, sequence: 1, state: 'live', payload: 'en' },
		],
		[
			'terminal tombstone',
			{ address: RECORD, sequence: 2, state: 'tombstone' },
		],
		['reversible unset', { address: VALUE, sequence: 2, state: 'unset' }],
	];
	for (const [name, fact] of facts) {
		test(`${name} parses`, () => {
			expect(expectOk(parseFact(fact, LIMITS))).toEqual(fact);
		});
	}
});

describe('four operations', () => {
	const intents: Array<[string, Intent]> = [
		[
			'patch',
			{ address: RECORD, op: 'patch', set: { title: 'A' }, unset: ['old'] },
		],
		['create-as-patch', { address: RECORD, op: 'patch', set: {}, unset: [] }],
		['replace', { address: VALUE, op: 'replace', value: 'en' }],
		['replace with null', { address: VALUE, op: 'replace', value: null }],
		['tombstone', { address: RECORD, op: 'tombstone' }],
		['unset', { address: VALUE, op: 'unset' }],
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
			parseFact({ address: RECORD, sequence: 0, state: 'tombstone' }, LIMITS),
		);
		expectErr(
			parseFact({ address: RECORD, sequence: -1, state: 'tombstone' }, LIMITS),
		);
	});
	test('rejects a live fact without a payload', () => {
		expectErr(
			parseFact({ address: RECORD, sequence: 1, state: 'live' }, LIMITS),
		);
	});
	test('rejects an absent fact carrying a payload, even null', () => {
		expectErr(
			parseFact(
				{ address: RECORD, sequence: 1, state: 'tombstone', payload: {} },
				LIMITS,
			),
		);
		expectErr(
			parseFact(
				{ address: VALUE, sequence: 1, state: 'unset', payload: null },
				LIMITS,
			),
		);
	});
	test('rejects the legacy presence axis and kinded payload members', () => {
		expectErr(
			parseFact(
				{ address: RECORD, sequence: 1, presence: 'present', fields: {} },
				LIMITS,
			),
		);
		expectErr(
			parseFact(
				{ address: RECORD, sequence: 1, state: 'live', fields: {} },
				LIMITS,
			),
		);
		expectErr(
			parseFact(
				{ address: VALUE, sequence: 1, state: 'live', content: 'en' },
				LIMITS,
			),
		);
	});
	test('rejects the legacy changedSequence field', () => {
		expectErr(
			parseFact(
				{ address: RECORD, changedSequence: 1, state: 'live', payload: {} },
				LIMITS,
			),
		);
	});
	test('admits a fact at exactly the encoded ceiling and rejects one byte over', () => {
		const atFact: Fact = {
			address: VALUE,
			sequence: 1,
			state: 'live',
			payload: 'x'.repeat(20),
		};
		// Tight limit set to the fact's exact encoded size, then parsed under it.
		const size = encodedFactBytes(atFact);
		const tight = makeLimits({ maxEncodedFactBytes: size });
		expect(expectOk(parseFact(atFact, tight))).toEqual(atFact);
		const overFact: Fact = { ...atFact, payload: 'x'.repeat(21) };
		expect(encodedFactBytes(overFact)).toBe(size + 1);
		expectErr(parseFact(overFact, tight));
	});
});

describe('operation hostile input', () => {
	test('rejects legacy typed verbs and the presence axis', () => {
		expectErr(
			parseIntent(
				{
					kind: 'create',
					key: 'so.epicenter.notes.recordings',
					recordKey: RECORD.recordKey,
					fields: {},
				},
				LIMITS,
			),
		);
		expectErr(
			parseIntent(
				{ address: RECORD, presence: 'present', set: {}, unset: [] },
				LIMITS,
			),
		);
		expectErr(parseIntent({ address: RECORD, presence: 'absent' }, LIMITS));
	});
	test('rejects an unknown operation discriminant', () => {
		expectErr(parseIntent({ address: RECORD, op: 'merge', set: {} }, LIMITS));
	});
	test('rejects a patch whose set and unset overlap', () => {
		expectErr(
			parseIntent(
				{ address: RECORD, op: 'patch', set: { title: 'A' }, unset: ['title'] },
				LIMITS,
			),
		);
	});
	test('rejects a patch with a duplicate unset key', () => {
		expectErr(
			parseIntent(
				{ address: RECORD, op: 'patch', set: {}, unset: ['a', 'a'] },
				LIMITS,
			),
		);
	});
	test('rejects a tombstone or unset carrying arguments, closing the shape', () => {
		expectErr(
			parseIntent({ address: RECORD, op: 'tombstone', value: null }, LIMITS),
		);
		expectErr(
			parseIntent({ address: VALUE, op: 'unset', set: {}, unset: [] }, LIMITS),
		);
	});
	test('rejects a replace with an extra field, closing the shape', () => {
		expectErr(
			parseIntent(
				{ address: VALUE, op: 'replace', value: 'en', extra: 1 },
				LIMITS,
			),
		);
	});
	test('rejects a replace missing its value', () => {
		expectErr(parseIntent({ address: VALUE, op: 'replace' }, LIMITS));
	});
	test('rejects a non-JSON payload', () => {
		expectErr(
			parseIntent({ address: VALUE, op: 'replace', value: Number.NaN }, LIMITS),
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
					{ address: RECORD, sequence: 1, state: 'tombstone', [noise]: 1 },
					LIMITS,
				),
			);
		}
	});
});

describe('non-JSON payload shapes are rejected', () => {
	const replace = (value: unknown): unknown => ({
		address: VALUE,
		op: 'replace',
		value,
	});

	test('a lone surrogate in a replace payload is rejected', () => {
		expectErr(parseIntent(replace(loneSurrogate), LIMITS));
	});

	test('a lone surrogate in a field key is rejected', () => {
		expectErr(
			parseIntent(
				{
					address: RECORD,
					op: 'patch',
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
				{ address: VALUE, sequence: 1, state: 'live', payload: loneSurrogate },
				LIMITS,
			),
		);
	});

	test('a sparse array payload is rejected', () => {
		const sparse = [1, 2, 3];
		delete sparse[1]; // introduce a hole without a sparse literal
		expectErr(parseIntent(replace(sparse), LIMITS));
	});

	test('an array with an extra own property is rejected', () => {
		const array: unknown[] = [1, 2];
		(array as unknown as Record<string, unknown>).extra = 3;
		expectErr(parseIntent(replace(array), LIMITS));
	});

	test('a symbol-keyed payload object is rejected', () => {
		const object: Record<string, unknown> = { a: 1 };
		(object as Record<symbol, unknown>)[Symbol('s')] = 2;
		expectErr(parseIntent(replace(object), LIMITS));
	});

	test('an accessor property in a payload object is rejected', () => {
		const object = {};
		Object.defineProperty(object, 'a', { get: () => 1, enumerable: true });
		expectErr(parseIntent(replace(object), LIMITS));
	});

	test('a non-enumerable property in a payload object is rejected', () => {
		const object = {};
		Object.defineProperty(object, 'a', {
			value: 1,
			enumerable: false,
			configurable: true,
		});
		expectErr(parseIntent(replace(object), LIMITS));
	});

	test('a class instance payload is rejected', () => {
		class Point {
			x = 1;
		}
		expectErr(parseIntent(replace(new Point()), LIMITS));
	});

	test('an exotic property on the intent object itself is rejected without throwing', () => {
		const base: Intent = { address: VALUE, op: 'replace', value: 'en' };
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
			state: 'live',
			payload: 'en',
		};
		const withHidden = { ...base };
		Object.defineProperty(withHidden, 'sneak', {
			value: 1,
			enumerable: false,
		});
		expectErr(parseFact(withHidden, LIMITS));
	});
});

describe('an absence operation must be able to install its fact', () => {
	test('rejects an absence operation whose max-sequence fact exceeds the ceiling', () => {
		const tiny = makeLimits({ maxEncodedFactBytes: 100 });
		// The absent fact carries a full address and a max sequence, over 100 bytes.
		expectErr(parseIntent({ address: RECORD, op: 'tombstone' }, tiny));
		expectErr(parseIntent({ address: RECORD, op: 'unset' }, tiny));
	});

	test('admits an absence operation whose fact fits the ceiling', () => {
		expectOk(parseIntent({ address: RECORD, op: 'tombstone' }, LIMITS));
		expectOk(parseIntent({ address: RECORD, op: 'unset' }, LIMITS));
	});
});
