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
import * as Y from '@y/y';

import { makeLimits } from '../protocol/v1/kernel.test-support.js';
import {
	DOCUMENT_ACCEPTANCE_CONFLICT_STATUS,
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentAcceptance,
	type DocumentPublicationRequest,
	documentPayloadDigest,
	encodeDocumentAcceptance,
	parseDocumentAcceptance,
	parseDocumentPublicationRequest,
	readDocumentAcceptance,
} from './index.js';

const limits = makeLimits();
const document = new Y.Doc({ gc: true });
document.get('content').insert(0, 'valid');
const payload = new Uint8Array(Y.encodeStateAsUpdateV2(document));
document.destroy();
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
	const firstByte = candidate.payload[0];
	const admitted = parseDocumentPublicationRequest(candidate, limits);
	expect(admitted).toEqual(candidate);
	expect(admitted?.payload).not.toBe(candidate.payload);
	candidate.payload[0] = 9;
	expect(admitted?.payload[0]).toBe(firstByte);
});

test('document publication admission refuses mismatched integrity and hostile shapes', () => {
	const malformed = new Uint8Array([1, 2, 3]);
	expect(
		parseDocumentPublicationRequest(
			{
				...request,
				payload: malformed,
				digest: documentPayloadDigest(malformed),
			},
			limits,
		),
	).toBeUndefined();
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
});

/**
 * Both shipped HTTP carriers used to throw on any non-2xx status before
 * reading the body, which discarded every authority decision the route
 * answers with a conflict status and turned a settled refusal into an
 * unbounded publish-retry loop.
 */
test('a conflict response decodes as a typed refusal instead of throwing', async () => {
	const refusals: DocumentAcceptance[] = [
		{
			authorityLifetime: 'lifetime-one',
			address: request.address,
			protocolVersion: DOCUMENT_PUBLICATION_VERSION,
			digest: request.digest,
			kind: 'document-bound',
			measured: {
				stateBytes: DOCUMENT_BOUND.stateBytes + 1,
				stateStructs: DOCUMENT_BOUND.stateStructs,
			},
			limit: DOCUMENT_BOUND,
		},
		{
			kind: 'record-not-live',
			activeAuthorityLifetime: 'lifetime-one',
			address: request.address,
			state: 'absent',
		},
		{ kind: 'lifetime-mismatch', activeAuthorityLifetime: 'lifetime-two' },
	];
	for (const refusal of refusals) {
		const response = new Response(encodeDocumentAcceptance(refusal), {
			status: DOCUMENT_ACCEPTANCE_CONFLICT_STATUS,
			headers: { 'content-type': 'application/json' },
		});
		expect(await readDocumentAcceptance(response, limits)).toEqual(refusal);
	}
});

test('an accepted publication decodes from the success status', async () => {
	const accepted: DocumentAcceptance = {
		kind: 'accepted',
		receipt: {
			authorityLifetime: 'lifetime-one',
			address: request.address,
			protocolVersion: DOCUMENT_PUBLICATION_VERSION,
			digest: request.digest,
		},
	};
	const response = new Response(encodeDocumentAcceptance(accepted), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	});
	expect(await readDocumentAcceptance(response, limits)).toEqual(accepted);
});

test('unexpected statuses and bodies stay operational, never typed refusals', async () => {
	// An unrelated status is operational even when its body would parse: only
	// the two statuses the route actually answers carry an authority decision.
	const wellFormed = encodeDocumentAcceptance({
		kind: 'lifetime-mismatch',
		activeAuthorityLifetime: 'lifetime-two',
	});
	for (const status of [401, 403, 404, 413, 500, 502]) {
		await expect(
			readDocumentAcceptance(new Response(wellFormed, { status }), limits),
		).rejects.toThrow(new RegExp(`publication failed \\(${status}\\)`));
	}
	// A conflict from something that is not the authority is not a refusal.
	await expect(
		readDocumentAcceptance(
			new Response('<html>proxy conflict</html>', {
				status: DOCUMENT_ACCEPTANCE_CONFLICT_STATUS,
			}),
			limits,
		),
	).rejects.toThrow();
	await expect(
		readDocumentAcceptance(
			new Response(JSON.stringify({ kind: 'invented' }), {
				status: DOCUMENT_ACCEPTANCE_CONFLICT_STATUS,
			}),
			limits,
		),
	).rejects.toThrow(/response was invalid/);
});
