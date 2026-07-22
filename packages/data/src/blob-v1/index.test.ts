import { describe, expect, test } from 'bun:test';

import { BLOB_PUBLICATION_VERSION, isBlobDigest } from './index.js';

describe('blob publication V1', () => {
	test('freezes one private protocol version', () => {
		expect(BLOB_PUBLICATION_VERSION).toBe('epicenter-blob-v1');
	});

	test('admits only lowercase SHA-256 hexadecimal digests', () => {
		expect(isBlobDigest('a'.repeat(64))).toBe(true);
		expect(isBlobDigest('A'.repeat(64))).toBe(false);
		expect(isBlobDigest('a'.repeat(63))).toBe(false);
		expect(isBlobDigest(`${'a'.repeat(63)}z`)).toBe(false);
		expect(isBlobDigest(null)).toBe(false);
	});
});
