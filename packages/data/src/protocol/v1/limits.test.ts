/**
 * Scalar V1 Limits Validation Tests
 *
 * Proves the mandatory limits validator: it accepts only self-consistent
 * ceilings and derives (never trusts) the response envelope, so the facts and
 * submission responses provably fit their worst case.
 *
 * Key behaviors:
 * - Non-integer, negative, and zero-where-positive ceilings are rejected
 * - The facts-response ceiling must hold one maximum fact plus its envelope
 * - The submission-response ceiling must satisfy the settlement inequality with
 *   a full set of maximum parked entries
 * - Both capacity checks are inclusive: at the derived minimum valid, one below
 *   invalid
 */
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';

import {
	minimumFactsResponseBytes,
	minimumSubmissionResponseBytes,
	type ScalarSyncLimits,
	validateLimits,
} from './index.js';
import { BASE_LIMITS } from './kernel.test-support.js';

const raw = (overrides: Partial<ScalarSyncLimits> = {}): ScalarSyncLimits => ({
	...BASE_LIMITS,
	...overrides,
});

describe('integer ceilings', () => {
	test('the base limits validate', () => {
		expectOk(validateLimits(raw()));
	});
	test('rejects a non-integer ceiling', () => {
		expectErr(validateLimits(raw({ maxEncodedFactBytes: 4096.5 })));
	});
	test('rejects a negative ceiling', () => {
		expectErr(validateLimits(raw({ maxNamespaceBytes: -1 })));
	});
	test('rejects zero where a positive value is required', () => {
		expectErr(validateLimits(raw({ maxEncodedFactBytes: 0 })));
		expectErr(validateLimits(raw({ jsonDepth: 0 })));
	});
	test('accepts zero for fields with a meaningful zero', () => {
		expectOk(
			validateLimits(raw({ maxUnsetKeysPerIntent: 0, propertiesPerObject: 0 })),
		);
	});
	test('rejects an unsafe-integer ceiling', () => {
		expectErr(validateLimits(raw({ maxSubmissionResponseBytes: 2 ** 53 })));
	});
});

describe('facts-response capacity is inclusive', () => {
	test('at the derived minimum valid, one below invalid', () => {
		const minimum = minimumFactsResponseBytes(raw());
		expectOk(validateLimits(raw({ maxFactsResponseBytes: minimum })));
		expectErr(validateLimits(raw({ maxFactsResponseBytes: minimum - 1 })));
	});
});

describe('submission-response settlement inequality is inclusive', () => {
	test('at the derived minimum valid, one below invalid', () => {
		const minimum = minimumSubmissionResponseBytes(raw());
		expectOk(validateLimits(raw({ maxSubmissionResponseBytes: minimum })));
		expectErr(validateLimits(raw({ maxSubmissionResponseBytes: minimum - 1 })));
	});
});

describe('response envelope models worst-case lifetime escaping', () => {
	test('each extra lifetime byte reserves six canonical bytes, not one', () => {
		// A control-char lifetime escapes to six canonical bytes per input byte, so
		// growing maxLifetimeBytes by ten must reserve sixty more envelope bytes.
		const factsDelta =
			minimumFactsResponseBytes(raw({ maxLifetimeBytes: 20 })) -
			minimumFactsResponseBytes(raw({ maxLifetimeBytes: 10 }));
		expect(factsDelta).toBe(60);
		const submissionDelta =
			minimumSubmissionResponseBytes(raw({ maxLifetimeBytes: 20 })) -
			minimumSubmissionResponseBytes(raw({ maxLifetimeBytes: 10 }));
		expect(submissionDelta).toBe(60);
	});
});

describe('validation allocates nothing proportional to ceilings', () => {
	// A safe-integer ceiling as large as Number.MAX_SAFE_INTEGER must refuse via
	// arithmetic overflow of the derived minimum, never allocate a string of that
	// length (which throws RangeError: Out of memory) and never throw.
	const huge = Number.MAX_SAFE_INTEGER;
	for (const key of [
		'maxLifetimeBytes',
		'maxNamespaceBytes',
		'maxTableKeyBytes',
		'maxEncodedFactBytes',
		'maxSubmissionAddresses',
	] as const) {
		test(`a Number.MAX_SAFE_INTEGER ${key} refuses without throwing or allocating`, () => {
			expectErr(validateLimits(raw({ [key]: huge })));
		});
	}

	test('a non-representable derived minimum reports positive infinity', () => {
		expect(minimumFactsResponseBytes(raw({ maxEncodedFactBytes: huge }))).toBe(
			Number.POSITIVE_INFINITY,
		);
		expect(
			minimumSubmissionResponseBytes(raw({ maxSubmissionAddresses: huge })),
		).toBe(Number.POSITIVE_INFINITY);
	});

	test('the base limits derive finite minima', () => {
		expect(Number.isFinite(minimumFactsResponseBytes(raw()))).toBe(true);
		expect(Number.isFinite(minimumSubmissionResponseBytes(raw()))).toBe(true);
	});
});

describe('validateLimits is total over unknown input', () => {
	test('non-object and exotic inputs refuse without throwing', () => {
		// Hostile proxies can fail at every reflective stage of admission. Each trap
		// must become a typed Invalid, never an escaping exception.
		const hostileProxies = [
			new Proxy(
				{},
				{
					getPrototypeOf() {
						throw new Error('getPrototypeOf trap');
					},
				},
			),
			new Proxy(
				{},
				{
					ownKeys() {
						throw new Error('ownKeys trap');
					},
				},
			),
			new Proxy(
				{ ...BASE_LIMITS },
				{
					getOwnPropertyDescriptor() {
						throw new Error('getOwnPropertyDescriptor trap');
					},
				},
			),
			new Proxy(
				{ ...BASE_LIMITS },
				{
					get(target, key, receiver) {
						if (key === 'maxNamespaceBytes') throw new Error('get trap');
						return Reflect.get(target, key, receiver);
					},
				},
			),
		];
		for (const value of [
			null,
			undefined,
			42,
			'limits',
			true,
			[BASE_LIMITS],
			new Date(),
			...hostileProxies,
		]) {
			expect(() => validateLimits(value)).not.toThrow();
			expectErr(validateLimits(value));
		}
	});

	test('a missing key, an extra key, and a non-number value each refuse', () => {
		const { maxNamespaceBytes: _dropped, ...missing } = BASE_LIMITS;
		expectErr(validateLimits(missing));
		expectErr(validateLimits({ ...BASE_LIMITS, extra: 1 }));
		expectErr(validateLimits({ ...BASE_LIMITS, maxEncodedFactBytes: '4096' }));
	});

	test('an inherited expected key cannot balance a missing own key with an extra key', () => {
		const original = Object.getOwnPropertyDescriptor(
			Object.prototype,
			'maxNamespaceBytes',
		);
		try {
			Object.defineProperty(Object.prototype, 'maxNamespaceBytes', {
				configurable: true,
				value: BASE_LIMITS.maxNamespaceBytes,
			});
			const { maxNamespaceBytes: _dropped, ...missing } = BASE_LIMITS;
			expectErr(validateLimits({ ...missing, extra: 1 }));
		} finally {
			if (original === undefined) {
				Reflect.deleteProperty(Object.prototype, 'maxNamespaceBytes');
			} else {
				Object.defineProperty(Object.prototype, 'maxNamespaceBytes', original);
			}
		}
	});

	test('validated properties bypass inherited setters and are immutable own data', () => {
		const input = { ...BASE_LIMITS };
		const original = Object.getOwnPropertyDescriptor(
			Object.prototype,
			'maxNamespaceBytes',
		);
		try {
			Object.defineProperty(Object.prototype, 'maxNamespaceBytes', {
				configurable: true,
				set() {
					throw new Error('inherited setter must not run');
				},
			});
			const validated = expectOk(validateLimits(input));
			expect(
				Object.getOwnPropertyDescriptor(validated, 'maxNamespaceBytes'),
			).toEqual({
				configurable: false,
				enumerable: true,
				value: BASE_LIMITS.maxNamespaceBytes,
				writable: false,
			});
		} finally {
			if (original === undefined) {
				Reflect.deleteProperty(Object.prototype, 'maxNamespaceBytes');
			} else {
				Object.defineProperty(Object.prototype, 'maxNamespaceBytes', original);
			}
		}
	});

	test('the validated value is a fresh, detached, deep-frozen copy', () => {
		const input = { ...BASE_LIMITS };
		const validated = expectOk(validateLimits(input));
		expect(Object.isFrozen(validated)).toBe(true);
		// Detached: mutating the caller's object cannot reach the validated value.
		input.maxEncodedFactBytes = 1;
		expect(validated.maxEncodedFactBytes).toBe(BASE_LIMITS.maxEncodedFactBytes);
		// Sealed: the validated value itself cannot be mutated.
		expect(() => {
			(validated as { maxEncodedFactBytes: number }).maxEncodedFactBytes = 1;
		}).toThrow();
	});
});
