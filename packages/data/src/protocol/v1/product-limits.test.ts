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

import { DATA_ADDRESS_CEILINGS } from '../admission.js';
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

describe('the shipped V1 ceilings are pinned', () => {
	/**
	 * Spelled out rather than compared against another constant, because there is
	 * no longer another constant to compare against: these numbers are the V1
	 * contract recorded in ADR-0163. A change here is a protocol change and has
	 * to be a deliberate edit to this list, not a side effect somewhere else.
	 */
	test('the exact ceilings ADR-0163 records', () => {
		expect(SCALAR_V1_LIMITS).toMatchObject({
			jsonDepth: 16,
			propertiesPerObject: 1024,
			maxNamespaceBytes: 128,
			maxTableKeyBytes: 64,
			maxValueKeyBytes: 128,
			maxLifetimeBytes: 64,
			maxFieldKeyBytes: 512,
			maxUnsetKeysPerIntent: 128,
			maxEncodedFactBytes: 508 * 1024,
			maxFactsResponseBytes: 8 * 1024 * 1024,
			maxSubmissionBytes: 768 * 1024,
			maxSubmissionAddresses: 8,
			maxSubmissionResponseBytes: 5 * 1024 * 1024,
		});
	});

	test('the address ceilings agree with the shared address grammar', () => {
		expect(SCALAR_V1_LIMITS.maxNamespaceBytes).toBe(
			DATA_ADDRESS_CEILINGS.namespaceBytes,
		);
		expect(SCALAR_V1_LIMITS.maxTableKeyBytes).toBe(
			DATA_ADDRESS_CEILINGS.tableNameBytes,
		);
		expect(SCALAR_V1_LIMITS.maxValueKeyBytes).toBe(
			DATA_ADDRESS_CEILINGS.valueNameBytes,
		);
	});
});
