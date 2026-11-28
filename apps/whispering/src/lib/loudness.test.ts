import { expect, test } from 'bun:test';
import { loudness } from './loudness';

test('loudness maps -60 dB to 0 and full scale to 1', () => {
	expect(loudness(0)).toBe(0);
	expect(loudness(-1)).toBe(0);
	expect(loudness(Number.NaN)).toBe(0);
	expect(loudness(0.001)).toBeCloseTo(0);
	expect(loudness(0.0001)).toBe(0);
	expect(loudness(0.1)).toBeCloseTo(2 / 3);
	expect(loudness(1)).toBe(1);
	expect(loudness(4)).toBe(1);
});
