/**
 * Local Model Display Tests
 *
 * Verifies the human-readable sizes shown on local-model download and deletion
 * actions so those destructive and network operations describe their cost.
 *
 * Key behaviors:
 * - Missing sizes stay blank
 * - Sub-gigabyte sizes use rounded decimal megabytes
 * - Gigabyte sizes use one decimal place
 */
import { expect, test } from 'bun:test';
import { formatModelSize } from './local-model-display';

test('missing model size stays blank', () => {
	expect(formatModelSize(null)).toBe('');
});

test('model size below one gigabyte uses rounded megabytes', () => {
	expect(formatModelSize(46_400_000)).toBe('46 MB');
});

test('model size at one gigabyte or larger uses one decimal place', () => {
	expect(formatModelSize(1_550_000_000)).toBe('1.6 GB');
});
