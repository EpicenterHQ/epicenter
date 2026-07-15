/**
 * Tab Display Formatting Tests
 *
 * Verifies the relative-time helper used by web captures after
 * lifecycle timestamps moved from epoch milliseconds to canonical UTC instants.
 */

/// <reference types="bun" />

import { expect, test } from 'bun:test';
import type { InstantString } from '@epicenter/field';
import { getRelativeTime } from './format';

test('getRelativeTime formats canonical UTC instants', () => {
	const twoMinutesAgo = new Date(
		Date.now() - 120_000,
	).toISOString() as InstantString;

	expect(getRelativeTime(twoMinutesAgo)).toBe('2m ago');
});
