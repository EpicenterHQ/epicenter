import { describe, expect, test } from 'bun:test';

import { SCALAR_SYNC_V1_LIMITS } from '../protocol/v1/index.js';
import {
	BLOB_PUBLICATION_VERSION,
	isBlobDigest,
	parseBlobPublicationRequest,
} from './index.js';

const VALID_REQUEST = {
	authorityLifetime: 'lifetime-one',
	address: {
		namespace: 'so.epicenter.notes',
		collection: 'assets',
		recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
	},
	protocolVersion: BLOB_PUBLICATION_VERSION,
	digest: 'a'.repeat(64),
};

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

	test('admits only exact bounded publication metadata', () => {
		expect(
			parseBlobPublicationRequest(VALID_REQUEST, SCALAR_SYNC_V1_LIMITS),
		).toEqual(VALID_REQUEST);
		for (const invalid of [
			{ ...VALID_REQUEST, extra: true },
			{ ...VALID_REQUEST, protocolVersion: 'epicenter-blob-v2' },
			{ ...VALID_REQUEST, authorityLifetime: '' },
			{ ...VALID_REQUEST, authorityLifetime: '\ud800' },
			{ ...VALID_REQUEST, digest: 'A'.repeat(64) },
			{ ...VALID_REQUEST, address: { ...VALID_REQUEST.address, extra: true } },
			Object.create(VALID_REQUEST),
		]) {
			expect(
				parseBlobPublicationRequest(invalid, SCALAR_SYNC_V1_LIMITS),
			).toBeUndefined();
		}
	});
});
