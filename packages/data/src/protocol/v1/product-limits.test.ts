/**
 * V1 Product Limits Tests
 *
 * Proves the shipped ceilings are self-consistent and that the two carried-over
 * product promises did not move during the scalar cutover.
 *
 * Key behaviors:
 * - The product set passes the mandatory validator (it is minted through it)
 * - Both response ceilings clear their derived minimums with real headroom
 * - The per-fact row-size promise and address-coordinate ceilings are unchanged
 *   from the protocol V1 replaces
 */
import { describe, expect, test } from 'bun:test';

import { DATA_ADMISSION_LIMITS } from '../admission.js';
import {
	minimumFactsResponseBytes,
	minimumSubmissionResponseBytes,
	SCALAR_V1_LIMITS,
} from './index.js';

describe('the product ceilings are self-consistent', () => {
	test('the facts response clears its derived minimum', () => {
		expect(SCALAR_V1_LIMITS.maxFactsResponseBytes).toBeGreaterThanOrEqual(
			minimumFactsResponseBytes(SCALAR_V1_LIMITS),
		);
	});

	test('the submission response satisfies the settlement inequality', () => {
		expect(SCALAR_V1_LIMITS.maxSubmissionResponseBytes).toBeGreaterThanOrEqual(
			minimumSubmissionResponseBytes(SCALAR_V1_LIMITS),
		);
	});

	/**
	 * The inequality is the reason the submission grouping shrank to eight
	 * addresses. Pinning it here means a future widening of the grouping fails
	 * loudly with the arithmetic in hand, rather than silently deriving a
	 * response ceiling no Worker can return.
	 */
	test('the configured submission response has headroom but is not absurd', () => {
		const minimum = minimumSubmissionResponseBytes(SCALAR_V1_LIMITS);
		expect(minimum).toBeLessThan(5 * 1024 * 1024);
		expect(SCALAR_V1_LIMITS.maxSubmissionResponseBytes).toBeLessThanOrEqual(
			8 * 1024 * 1024,
		);
	});
});

describe('carried-over product promises did not move', () => {
	test('a row may still hold the same encoded scalar payload', () => {
		expect(SCALAR_V1_LIMITS.maxEncodedFactBytes).toBe(
			DATA_ADMISSION_LIMITS.encodedFactBytes,
		);
	});

	test('the address coordinate ceilings are unchanged', () => {
		expect(SCALAR_V1_LIMITS.maxNamespaceBytes).toBe(
			DATA_ADMISSION_LIMITS.namespaceBytes,
		);
		expect(SCALAR_V1_LIMITS.maxTableKeyBytes).toBe(
			DATA_ADMISSION_LIMITS.tableNameBytes,
		);
		expect(SCALAR_V1_LIMITS.maxValueKeyBytes).toBe(
			DATA_ADMISSION_LIMITS.valueNameBytes,
		);
	});

	test('the row payload shape ceilings are unchanged', () => {
		expect(SCALAR_V1_LIMITS.maxFieldKeyBytes).toBe(
			DATA_ADMISSION_LIMITS.fieldKeyBytes,
		);
		expect(SCALAR_V1_LIMITS.maxUnsetKeysPerIntent).toBe(
			DATA_ADMISSION_LIMITS.unsetKeysPerIntent,
		);
		expect(SCALAR_V1_LIMITS.jsonDepth).toBe(DATA_ADMISSION_LIMITS.jsonDepth);
		expect(SCALAR_V1_LIMITS.propertiesPerObject).toBe(
			DATA_ADMISSION_LIMITS.propertiesPerObject,
		);
	});
});
