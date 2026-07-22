import { describe, expect, test } from 'bun:test';

import { BLOB_PUBLICATION_VERSION } from './blob-v1/index.js';
import { DOCUMENT_PUBLICATION_VERSION } from './document-v1/index.js';
import { createHttpRecordSyncTransport } from './record-sync-http.js';
import { RecordAuthorityLifetimeMismatchError } from './record-sync-supervisor.js';

const ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'notes',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

describe('record sync HTTP transport', () => {
	test('sends bounded bearer-authenticated requests for every plane', async () => {
		const requests: Request[] = [];
		const transport = createHttpRecordSyncTransport<Blob>({
			deploymentId: 'https://api.example.com/',
			credentials: { get: () => 'secret' },
			async fetch(request) {
				requests.push(request);
				const url = new URL(request.url);
				if (url.pathname.endsWith('/facts')) {
					return Response.json({
						authorityLifetime: 'lifetime-one',
						facts: [],
						hasMore: false,
					});
				}
				if (url.pathname.endsWith('/submissions')) {
					return Response.json({
						authorityLifetime: 'lifetime-one',
						facts: [],
						parked: [],
					});
				}
				if (url.pathname.endsWith('/document-publications')) {
					return Response.json({
						kind: 'accepted',
						receipt: {
							authorityLifetime: 'lifetime-one',
							address: ADDRESS,
							protocolVersion: DOCUMENT_PUBLICATION_VERSION,
							digest: 'd'.repeat(64),
						},
					});
				}
				return Response.json({
					kind: 'accepted',
					receipt: {
						authorityLifetime: 'lifetime-one',
						address: ADDRESS,
						protocolVersion: BLOB_PUBLICATION_VERSION,
						digest: 'b'.repeat(64),
					},
				});
			},
		});

		await transport.readFacts({
			authorityLifetime: 'lifetime-one',
			afterSequence: 7,
		});
		await transport.submit({ bytes: '{}', hash: 'a'.repeat(64) });
		await transport.publishDocument({
			authorityLifetime: 'lifetime-one',
			address: ADDRESS,
			protocolVersion: DOCUMENT_PUBLICATION_VERSION,
			payload: new Uint8Array([1, 2]),
			digest: 'd'.repeat(64),
		});
		await transport.publishBlob({
			request: {
				authorityLifetime: 'lifetime-one',
				address: ADDRESS,
				protocolVersion: BLOB_PUBLICATION_VERSION,
				digest: 'b'.repeat(64),
			},
			bytes: new Blob([new Uint8Array([3, 4])]),
		});

		expect(requests).toHaveLength(4);
		for (const request of requests) {
			expect(request.headers.get('authorization')).toBe('Bearer secret');
		}
		const factsUrl = new URL(requests[0]?.url ?? '');
		expect(factsUrl.pathname).toBe('/api/sync/v1/facts');
		expect(factsUrl.searchParams.get('authorityLifetime')).toBe('lifetime-one');
		expect(factsUrl.searchParams.get('afterSequence')).toBe('7');
		expect(requests[1]?.method).toBe('POST');
		expect(await requests[1]?.text()).toBe('{}');
		expect(requests[2]?.headers.get('x-epicenter-document-digest')).toBe(
			'd'.repeat(64),
		);
		expect(requests[3]?.headers.get('x-epicenter-blob-digest')).toBe(
			'b'.repeat(64),
		);
	});

	test('turns the scalar 409 lifetime response into the reset signal', async () => {
		const transport = createHttpRecordSyncTransport<Blob>({
			deploymentId: 'https://api.example.com/',
			credentials: { get: () => 'secret' },
			fetch: async () =>
				Response.json(
					{
						error: 'lifetime-mismatch',
						activeAuthorityLifetime: 'lifetime-two',
					},
					{ status: 409 },
				),
		});
		await expect(
			transport.readFacts({ afterSequence: 0 }),
		).rejects.toBeInstanceOf(RecordAuthorityLifetimeMismatchError);
	});

	test('rejects non-acceptance JSON instead of spinning an unknown plane result', async () => {
		const transport = createHttpRecordSyncTransport<Blob>({
			deploymentId: 'https://api.example.com/',
			credentials: { get: () => 'secret' },
			fetch: async () =>
				Response.json({ error: 'unauthorized' }, { status: 401 }),
		});
		await expect(
			transport.publishBlob({
				request: {
					authorityLifetime: 'lifetime-one',
					address: ADDRESS,
					protocolVersion: BLOB_PUBLICATION_VERSION,
					digest: 'b'.repeat(64),
				},
				bytes: new Blob([]),
			}),
		).rejects.toThrow('HTTP 401');
	});
});
