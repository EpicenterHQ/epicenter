import { describe, expect, test } from 'bun:test';
import type { RealmState } from '../src/db.ts';
import { decideMode } from '../src/sync.ts';

const NOW = Date.parse('2026-06-21T00:00:00.000Z');
const daysAgo = (n: number) =>
	new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const base = {
	now: NOW,
	cdcSafeWindowDays: 25,
	fullBackstopDays: 7,
};

function state(over: Partial<RealmState>): RealmState {
	return {
		cdcCursor: null,
		lastFullPullAt: null,
		lastSyncedAt: null,
		...over,
	};
}

describe('decideMode', () => {
	test('--full always forces FULL', () => {
		const decision = decideMode({
			...base,
			forceFull: true,
			realmState: state({ cdcCursor: daysAgo(1), lastFullPullAt: daysAgo(1) }),
		});
		expect(decision.mode).toBe('FULL');
		expect(decision.reason).toContain('forced');
	});

	test('first run (no state) is FULL', () => {
		expect(
			decideMode({ ...base, forceFull: false, realmState: state({}) }).mode,
		).toBe('FULL');
	});

	test('no cursor is FULL even with a recent recorded full pull', () => {
		const decision = decideMode({
			...base,
			forceFull: false,
			realmState: state({ lastFullPullAt: daysAgo(1) }),
		});
		expect(decision.mode).toBe('FULL');
		expect(decision.reason).toContain('no cursor');
	});

	test('recent cursor + recent full pull is INCREMENTAL', () => {
		const decision = decideMode({
			...base,
			forceFull: false,
			realmState: state({ cdcCursor: daysAgo(1), lastFullPullAt: daysAgo(2) }),
		});
		expect(decision.mode).toBe('INCREMENTAL');
	});

	test('cursor older than the CDC window forces FULL (gap is unrecoverable)', () => {
		const decision = decideMode({
			...base,
			forceFull: false,
			realmState: state({
				cdcCursor: daysAgo(26),
				lastFullPullAt: daysAgo(26),
			}),
		});
		expect(decision.mode).toBe('FULL');
		expect(decision.reason).toContain('CDC window');
	});

	test('stale last-full-pull forces FULL even with a fresh cursor (backstop)', () => {
		const decision = decideMode({
			...base,
			forceFull: false,
			realmState: state({ cdcCursor: daysAgo(1), lastFullPullAt: daysAgo(10) }),
		});
		expect(decision.mode).toBe('FULL');
		expect(decision.reason).toContain('backstop');
	});

	test('cursor present but no recorded full pull is FULL', () => {
		expect(
			decideMode({
				...base,
				forceFull: false,
				realmState: state({ cdcCursor: daysAgo(1), lastFullPullAt: null }),
			}).mode,
		).toBe('FULL');
	});
});
