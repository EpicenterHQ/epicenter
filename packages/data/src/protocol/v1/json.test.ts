/**
 * Scalar V1 Bounded JSON Admission Tests
 *
 * Verifies semantic JSON traversal independently of the wire-envelope parser,
 * especially at depths where recursive JavaScript validation exhausts the call
 * stack.
 *
 * Key behaviors:
 * - A 20,000-container payload is admitted when the depth limit includes it
 * - The same payload is rejected when it exceeds the depth limit
 * - Cycles, object fan-out, and hostile proxies reject without throwing
 * - Shared references reject (wire JSON is a tree); distinct-but-equal siblings pass
 */
import { expect, test } from 'bun:test';

import { isJsonValue } from './json.js';

function nestedArray(depth: number): unknown {
	let value: unknown = 0;
	for (let level = 0; level < depth; level += 1) value = [value];
	return value;
}

test('a 20,000-container payload is admitted within the depth limit', () => {
	const value = nestedArray(20000);

	expect(isJsonValue(value, { jsonDepth: 20000, propertiesPerObject: 0 })).toBe(
		true,
	);
	expect(isJsonValue(value, { jsonDepth: 19999, propertiesPerObject: 0 })).toBe(
		false,
	);
});

test('cycles and shared references both reject; distinct-but-equal siblings pass', () => {
	const shared = { value: 1 };
	const cycle: unknown[] = [];
	cycle.push(cycle);

	// The same object reached by two paths is not a tree; refuse it so the
	// canonical encoder is never handed a value it would expand.
	expect(
		isJsonValue([shared, shared], {
			jsonDepth: 2,
			propertiesPerObject: 1,
		}),
	).toBe(false);
	expect(isJsonValue(cycle, { jsonDepth: 2, propertiesPerObject: 1 })).toBe(
		false,
	);
	// Refusal is by identity, not value: two separate equal objects are a tree.
	expect(
		isJsonValue([{ value: 1 }, { value: 1 }], {
			jsonDepth: 2,
			propertiesPerObject: 1,
		}),
	).toBe(true);
});

test('object fan-out and hostile proxies reject without throwing', () => {
	const throwing = new Proxy(
		{ value: 1 },
		{
			ownKeys() {
				throw new Error('trap');
			},
		},
	);

	expect(
		isJsonValue(
			{ left: 1, right: 2 },
			{
				jsonDepth: 1,
				propertiesPerObject: 1,
			},
		),
	).toBe(false);
	expect(() =>
		isJsonValue(throwing, { jsonDepth: 1, propertiesPerObject: 1 }),
	).not.toThrow();
	expect(isJsonValue(throwing, { jsonDepth: 1, propertiesPerObject: 1 })).toBe(
		false,
	);
});
