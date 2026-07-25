import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	BLOB_PUBLICATION_VERSION,
	blobFileOwner,
} from '@epicenter/data/blob-v1';
import {
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentPublicationRequest,
	documentPayloadDigest,
} from '@epicenter/data/document-v1';
import {
	parseFactsRequest,
	parseSubmissionRequest,
	SCALAR_SYNC_V1_LIMITS,
	sha256Hex,
} from '@epicenter/data/protocol/v1';
import { asPrincipalId } from '@epicenter/identity';
import * as Y from '@y/y';
import { expectOk } from 'wellcrafted/testing';
import { createBunScalarV1Runtime } from './scalar-v1-bun.js';

test('Bun scalar V1 runtime reopens one durable authority per principal', async () => {
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

		await runtime.close();
		runtime = createBunScalarV1Runtime({ dir });
		authority = runtime.locateAuthority(principal);
		expect(expectOk(authority.submit(request)).facts[0]).toMatchObject({
			sequence: 1,
			payload: 'persisted',
		});
		expect(authority.acceptDocument(publication).kind).toBe('accepted');

		// A pull answers the same durable state the reopened authority holds.
		const pulled = authority.pullDocument({
			authorityLifetime: lifetime,
			address: publication.address,
			knownDocumentVersion: null,
		});
		expect(pulled.kind).toBe('state');

		const blobDigest = sha256Hex('recorded audio');
		const blobs = await runtime.locateBlobAuthority(principal);
		expect(
			await blobs.accept(
				{
					authorityLifetime: lifetime,
					address: publication.address,
					protocolVersion: BLOB_PUBLICATION_VERSION,
					digest: blobDigest,
				},
				new Blob(['recorded audio']).stream(),
			),
		).toMatchObject({ kind: 'accepted' });
		const owner = blobFileOwner(publication.address, blobDigest);
		const blobPath = join(
			dir,
			'principals',
			'principal-one',
			'blobs',
			'content',
			owner.ownerKey,
			owner.digest,
		);
		expect(existsSync(blobPath)).toBe(true);
		expectOk(
			authority.submit(
				expectOk(
					parseSubmissionRequest(
						{
							authorityLifetime: lifetime,
							replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
							submissionNumber: 2,
							intents: [{ address: publication.address, op: 'tombstone' }],
						},
						SCALAR_SYNC_V1_LIMITS,
					),
				),
			),
		);
		// The tombstone reaps the document too, so a later pull refuses.
		expect(
			authority.pullDocument({
				authorityLifetime: lifetime,
				address: publication.address,
				knownDocumentVersion: null,
			}),
		).toMatchObject({ kind: 'record-not-live', state: 'tombstone' });
		await runtime.locateBlobAuthority(principal);
		expect(existsSync(blobPath)).toBe(false);
	} finally {
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
