import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentPublicationRequest,
	documentPayloadDigest,
} from '@epicenter/data/document-v1';
import {
	parseFactsRequest,
	parseSubmissionRequest,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import { asPrincipalId } from '@epicenter/identity';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';

import { createBunScalarV1Runtime } from './scalar-v1-bun.js';

test('Bun scalar V1 runtime reopens one durable authority per principal', () => {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-scalar-v1-bun-'));
	const principal = asPrincipalId('principal-one');
	let runtime = createBunScalarV1Runtime({ dir });
	try {
		let authority = runtime.locateAuthority(principal);
		const lifetime = expectOk(
			authority.readFacts(
				expectOk(
					parseFactsRequest({ afterSequence: 0 }, SCALAR_SYNC_V1_LIMITS),
				),
			),
		).authorityLifetime;
		const request = expectOk(
			parseSubmissionRequest(
				{
					authorityLifetime: lifetime,
					replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
					submissionNumber: 1,
					intents: [
						{
							address: {
								namespace: 'so.epicenter.notes',
								collection: 'recordings',
								recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
							},
							op: 'replace',
							value: 'persisted',
						},
					],
				},
				SCALAR_SYNC_V1_LIMITS,
			),
		);
		expect(expectOk(authority.submit(request)).facts[0]).toMatchObject({
			sequence: 1,
			payload: 'persisted',
		});
		const document = new Y.Doc({ gc: true });
		document.get('content').insert(0, 'durable document');
		const payload = new Uint8Array(Y.encodeStateAsUpdateV2(document));
		document.destroy();
		const publication: DocumentPublicationRequest = {
			authorityLifetime: lifetime,
			address:
				request.intents[0]?.address ??
				(() => {
					throw new Error('missing intent');
				})(),
			protocolVersion: DOCUMENT_PUBLICATION_VERSION,
			payload,
			digest: documentPayloadDigest(payload),
		};
		expect(authority.acceptDocument(publication).kind).toBe('accepted');

		runtime.close();
		runtime = createBunScalarV1Runtime({ dir });
		authority = runtime.locateAuthority(principal);
		expect(expectOk(authority.submit(request)).facts[0]).toMatchObject({
			sequence: 1,
			payload: 'persisted',
		});
		expect(authority.acceptDocument(publication).kind).toBe('accepted');
	} finally {
		runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
