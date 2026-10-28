/**
 * Overlap Policy Tests
 *
 * `settle` is the only place an overlap becomes a decision, so each kind of
 * overlap is checked under both policies.
 *
 * Key behaviors:
 * - No overlaps land under either policy
 * - `'refuse'` refuses on any overlap, relocating nothing
 * - `'mark'` lands every overlap and records how it was settled
 */
import { describe, expect, test } from 'bun:test';
import { settle } from './policy.js';
import type { Overlap } from './protocol.js';

const cases: [Overlap, string][] = [
	[{ unit: 'body', base: 'cat', current: 'cart', incoming: 'coat', start: 0, end: 4 }, 'marked'],
	[{ unit: 'block', base: 'x', current: 'y', incoming: 'z', start: 0, end: 1 }, 'marked'],
	[{ unit: 'field', key: 'status', base: 'a', current: 'b', incoming: 'c' }, 'current-kept'],
	[{ unit: 'field', key: 'status', base: 'a', incoming: 'c' }, 'edit-kept'],
	[{ unit: 'file', clash: 'deleted', side: 'current' }, 'edit-kept'],
	[{ unit: 'file', clash: 'created' }, 'joined'],
	[{ unit: 'path', clash: 'reused', relocatedTo: 'a (bob, 2026-10-28).md' }, 'relocated'],
	[{ unit: 'path', clash: 'gone', relocatedTo: null }, 'dropped'],
];

describe('settle', () => {
	test('no overlaps land under either policy', () => {
		expect(settle([], 'mark')).toEqual({ kind: 'land', overlaps: [] });
		expect(settle([], 'refuse')).toEqual({ kind: 'land', overlaps: [] });
	});

	test("'mark' lands each kind and records how it was settled", () => {
		for (const [overlap, settled] of cases)
			expect(settle([overlap], 'mark')).toEqual({ kind: 'land', overlaps: [{ ...overlap, settled } as never] });
	});

	test("'refuse' refuses each kind with a reason, and relocates nothing", () => {
		for (const [overlap] of cases) {
			const decision = settle([overlap], 'refuse');
			expect(decision.kind).toBe('refuse');
			if (decision.kind !== 'refuse') continue;
			expect(decision.reason.length).toBeGreaterThan(0);
			for (const refused of decision.overlaps) if (refused.unit === 'path') expect(refused.relocatedTo).toBeNull();
		}
	});
});
