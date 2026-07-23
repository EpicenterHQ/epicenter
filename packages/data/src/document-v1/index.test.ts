/**
 * Document Publication V1 Wire Tests
 *
 * Verifies exact publication admission and the shared semantic acceptance
 * encoding carried by HTTP and realtime WebSocket responses.
 *
 * Key behaviors:
 * - Publication payload integrity is admitted at the binary boundary
 * - Every authority acceptance variant round-trips through one validator
 * - Malformed or hostile acceptance shapes are refused
 */
import { expect, test } from 'bun:test';

import { DOCUMENT_BOUND } from '@epicenter/sync/document-v3';

import { makeLimits } from '../protocol/v1/kernel.test-support.js';
import {
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentAcceptance,
	type DocumentPublicationRequest,
	decodeDocumentAcceptance,
	documentPayloadDigest,
	encodeDocumentAcceptance,
	parseDocumentAcceptance,
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

test('one acceptance encoding round trips every HTTP and WebSocket result', () => {
	const receipt = {
		authorityLifetime: request.authorityLifetime,
		address: request.address,
		protocolVersion: request.protocolVersion,
		digest: request.digest,
	};
	const acceptances: DocumentAcceptance[] = [
		{ kind: 'accepted', receipt },
		{
			...receipt,
			kind: 'document-bound',
			measured: {
				stateBytes: DOCUMENT_BOUND.stateBytes + 1,
				stateStructs: DOCUMENT_BOUND.stateStructs,
			},
			limit: DOCUMENT_BOUND,
		},
		{
			kind: 'record-not-live',
			activeAuthorityLifetime: request.authorityLifetime,
			address: request.address,
			state: 'tombstone',
		},
		{
			kind: 'lifetime-mismatch',
			activeAuthorityLifetime: request.authorityLifetime,
		},
	];

	for (const acceptance of acceptances) {
		const encoded = encodeDocumentAcceptance(acceptance);
		expect(decodeDocumentAcceptance(encoded, limits)).toEqual(acceptance);
		expect(
			parseDocumentAcceptance(
				JSON.parse(new TextDecoder().decode(encoded)),
				limits,
			),
		).toEqual(acceptance);
	}
});

test('acceptance admission refuses wrong proofs, bounds, and hostile shapes', () => {
	const accepted = {
		kind: 'accepted',
		receipt: {
			authorityLifetime: request.authorityLifetime,
			address: request.address,
			protocolVersion: request.protocolVersion,
			digest: request.digest,
		},
	};
	expect(
		parseDocumentAcceptance(
			{ ...accepted, receipt: { ...accepted.receipt, digest: 'bad' } },
			limits,
		),
	).toBeUndefined();
	expect(
		parseDocumentAcceptance(
			{
				...accepted.receipt,
				kind: 'document-bound',
				measured: {
					stateBytes: DOCUMENT_BOUND.stateBytes + 1,
					stateStructs: 1,
				},
				limit: { ...DOCUMENT_BOUND, stateBytes: DOCUMENT_BOUND.stateBytes - 1 },
			},
			limits,
		),
	).toBeUndefined();
	expect(
		parseDocumentAcceptance(
			{
				...accepted.receipt,
				kind: 'document-bound',
				measured: DOCUMENT_BOUND,
				limit: DOCUMENT_BOUND,
			},
			limits,
		),
	).toBeUndefined();
	expect(
		parseDocumentAcceptance(
			new Proxy(accepted, {
				getPrototypeOf() {
					throw new Error('hostile');
				},
			}),
			limits,
		),
	).toBeUndefined();
	expect(
		decodeDocumentAcceptance(new TextEncoder().encode('{'), limits),
	).toBeUndefined();
});
