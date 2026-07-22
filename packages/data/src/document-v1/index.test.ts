import { expect, test } from 'bun:test';

import { makeLimits } from '../protocol/v1/kernel.test-support.js';
import {
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentPublicationRequest,
	documentPayloadDigest,
	parseDocumentPublicationRequest,
} from './index.js';

const limits = makeLimits();
const payload = new Uint8Array([1, 2, 3]);
const request: DocumentPublicationRequest = {
	authorityLifetime: 'lifetime-one',
	address: {
		namespace: 'so.epicenter.notes',
		collection: 'records',
		recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
	},
	protocolVersion: DOCUMENT_PUBLICATION_VERSION,
	payload,
	digest: documentPayloadDigest(payload),
};

test('document publication admission owns and validates exact binary bytes', () => {
	const candidate = { ...request, payload: new Uint8Array(request.payload) };
	const admitted = parseDocumentPublicationRequest(candidate, limits);
	expect(admitted).toEqual(candidate);
	expect(admitted?.payload).not.toBe(candidate.payload);
	candidate.payload[0] = 9;
	expect(admitted?.payload[0]).toBe(1);
});

test('document publication admission refuses mismatched integrity and hostile shapes', () => {
	expect(
		parseDocumentPublicationRequest(
			{ ...request, digest: 'f'.repeat(64) },
			limits,
		),
	).toBeUndefined();
	expect(
		parseDocumentPublicationRequest({ ...request, extra: true }, limits),
	).toBeUndefined();
	expect(
		parseDocumentPublicationRequest(
			new Proxy(request, {
				getPrototypeOf() {
					throw new Error('hostile');
				},
			}),
			limits,
		),
	).toBeUndefined();
});
