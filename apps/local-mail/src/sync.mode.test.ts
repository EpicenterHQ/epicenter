import { describe, expect, test } from 'bun:test';
import type { CacheState } from './mailbox.ts';
import { decideMode } from './sync.ts';

const NOW = Date.parse('2026-07-01T00:00:00.000Z');
const daysAgo = (n: number) =>
	new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const base = {
	now: NOW,
	historySafeWindowDays: 5,
	fullBackstopDays: 30,
};

function state(over: Partial<CacheState>): CacheState {
	return {
		historyId: null,
		lastFullPullAt: null,
		lastSyncedAt: null,
		...over,
	};
}

describe('decideMode', () => {
	test('first run (no history cursor) is FULL', () => {
		expect(decideMode({ ...base, cacheState: state({}) }).mode).toBe('FULL');
	});

	test('cursor present but no recorded sync time is FULL (defensive: should not happen)', () => {
		expect(
			decideMode({
				...base,

				cacheState: state({ historyId: '100', lastSyncedAt: null }),
			}).mode,
		).toBe('FULL');
	});

	test('recent sync + recent full pull is INCREMENTAL', () => {
		const decision = decideMode({
			...base,

			cacheState: state({
				historyId: '100',
				lastSyncedAt: daysAgo(1),
				lastFullPullAt: daysAgo(2),
			}),
		});
		expect(decision.mode).toBe('INCREMENTAL');
	});

	test('last sync older than the safe window forces FULL (historyId likely expired)', () => {
		const decision = decideMode({
			...base,

			cacheState: state({
				historyId: '100',
				lastSyncedAt: daysAgo(6),
				lastFullPullAt: daysAgo(6),
			}),
		});
		expect(decision.mode).toBe('FULL');
		expect(decision.reason).toContain('safe window');
	});

	test('last full pull older than the backstop forces FULL even with a fresh sync', () => {
		const decision = decideMode({
			...base,

			cacheState: state({
				historyId: '100',
				lastSyncedAt: daysAgo(1),
				lastFullPullAt: daysAgo(31),
			}),
		});
		expect(decision.mode).toBe('FULL');
		expect(decision.reason).toContain('backstop');
	});

	test('no recorded full pull at all is FULL', () => {
		const decision = decideMode({
			...base,

			cacheState: state({
				historyId: '100',
				lastSyncedAt: daysAgo(1),
				lastFullPullAt: null,
			}),
		});
		expect(decision.mode).toBe('FULL');
		expect(decision.reason).toContain('no recorded full pull');
	});
});
