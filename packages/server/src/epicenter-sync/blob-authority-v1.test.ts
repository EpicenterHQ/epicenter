import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	BLOB_PUBLICATION_VERSION,
	type BlobPublicationRequest,
} from '@epicenter/data/blob-v1';
import { createBunBlobFileStore } from '@epicenter/data/bun';
import { parseSubmissionRequest, sha256Hex } from '@epicenter/data/protocol/v1';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectOk } from 'wellcrafted/testing';

import { openScalarAuthorityV1 } from './authority-v1.js';
import { authorityV1TestLimits } from './authority-v1-cases.test-support.js';
import { createAuthorityBlobV1 } from './blob-authority-v1.js';
import { createAuthorityCaptureManifestV1 } from './capture-manifest-v1.js';

const LIFETIME = 'lifetime-one';
const ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'assets',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

async function* source(value: string): AsyncIterable<Uint8Array> {
	yield new TextEncoder().encode(value);
}

async function textOf(
	source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): Promise<string> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	const collected: Uint8Array[] = [];
	if ('getReader' in source) {
		const reader = source.getReader();
		try {
			while (true) {
				const result = await reader.read();
				if (result.done) break;
				collected.push(result.value);
			}
		} finally {
			reader.releaseLock();
		}
	} else {
		for await (const chunk of source) collected.push(chunk);
	}
	for (const chunk of collected) {
		chunks.push(chunk);
		length += chunk.byteLength;
	}
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(result);
}

function request(value: string): BlobPublicationRequest {
	return {
		authorityLifetime: LIFETIME,
		address: ADDRESS,
		protocolVersion: BLOB_PUBLICATION_VERSION,
		digest: sha256Hex(value),
	};
}

async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-authority-blobs-'));
	const raw = new Database(join(root, 'authority.sqlite'), {
		create: true,
		strict: true,
	});
	const database = createBunSqliteAdapter(raw);
	const limits = authorityV1TestLimits();
	const authority = openScalarAuthorityV1({
		database,
		limits,
		initialize: { authorityLifetime: LIFETIME },
	});
	let submissionNumber = 1;
	function submit(op: 'replace' | 'unset' | 'tombstone') {
		const result = authority.submit(
			expectOk(
				parseSubmissionRequest(
					{
						authorityLifetime: LIFETIME,
						replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
						submissionNumber,
						intents: [
							op === 'replace'
								? { address: ADDRESS, op, value: {} }
								: { address: ADDRESS, op },
						],
					},
					limits,
				),
			),
		);
		expectOk(result);
		submissionNumber += 1;
	}
	submit('replace');
	const blobs = createAuthorityBlobV1(database, createBunBlobFileStore(root));
	return {
		root,
		raw,
		authority,
		blobs,
		submit,
		async close() {
			raw.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

function captureState(raw: Database): {
	recordRevision: number;
	nextRevision: number;
} {
	const record = raw
		.query<{ capture_revision: number }, []>(
			'SELECT capture_revision FROM records WHERE record_id = 1',
		)
		.get();
	const meta = raw
		.query<{ next_capture_revision: number }, []>(
			'SELECT next_capture_revision FROM meta WHERE singleton = 1',
		)
		.get();
	if (record === null || meta === null)
		throw new Error('capture state is missing');
	return {
		recordRevision: record.capture_revision,
		nextRevision: meta.next_capture_revision,
	};
}

describe('record blob authority', () => {
	test('accepts A, retries A idempotently, and refuses B without replacement', async () => {
		const context = await setup();
		try {
			expect(captureState(context.raw)).toEqual({
				recordRevision: 1,
				nextRevision: 2,
			});
			const a = request('first');
			expect(await context.blobs.accept(a, source('first'))).toEqual({
				kind: 'accepted',
				receipt: a,
			});
			expect(captureState(context.raw)).toEqual({
				recordRevision: 2,
				nextRevision: 3,
			});
			expect(await context.blobs.accept(a, source('first'))).toEqual({
				kind: 'accepted',
				receipt: a,
			});
			expect(captureState(context.raw)).toEqual({
				recordRevision: 2,
				nextRevision: 3,
			});
			const b = request('second');
			expect(await context.blobs.accept(b, source('second'))).toEqual({
				kind: 'blob-conflict',
				receipt: b,
				acceptedDigest: a.digest,
			});
			expect(captureState(context.raw)).toEqual({
				recordRevision: 2,
				nextRevision: 3,
			});
			const bytes = await context.blobs.read(ADDRESS);
			if (bytes === undefined) throw new Error('accepted blob is missing');
			expect(await textOf(bytes)).toBe('first');
		} finally {
			await context.close();
		}
	});

	test('unset retains membership while tombstone reaps it', async () => {
		const context = await setup();
		try {
			const publication = request('retained');
			await context.blobs.accept(publication, source('retained'));
			context.submit('unset');
			expect(await context.blobs.read(ADDRESS)).toBeUndefined();
			await context.blobs.sweepDebris();
			context.submit('replace');
			const retained = await context.blobs.read(ADDRESS);
			if (retained === undefined) throw new Error('unset reaped blob bytes');
			expect(await textOf(retained)).toBe('retained');

			context.submit('tombstone');
			await context.blobs.sweepDebris();
			expect(await context.blobs.read(ADDRESS)).toBeUndefined();
		} finally {
			await context.close();
		}
	});

	test('mismatched bytes and non-live records never gain membership', async () => {
		const context = await setup();
		try {
			let consumed = false;
			async function* staleSource() {
				consumed = true;
				yield new TextEncoder().encode('stale');
			}
			expect(
				await context.blobs.accept(
					{ ...request('stale'), authorityLifetime: 'stale-lifetime' },
					staleSource(),
				),
			).toEqual({
				kind: 'lifetime-mismatch',
				activeAuthorityLifetime: LIFETIME,
			});
			expect(consumed).toBe(false);

			await expect(
				context.blobs.accept(request('claimed'), source('different')),
			).rejects.toThrow(/do not match/);
			expect(await readdir(join(context.root, 'blobs', 'staging'))).toEqual([]);
			await context.blobs.reopenSweep();
			expect(await context.blobs.read(ADDRESS)).toBeUndefined();

			context.submit('tombstone');
			const publication = request('late');
			expect(await context.blobs.accept(publication, source('late'))).toEqual({
				kind: 'record-not-live',
				activeAuthorityLifetime: LIFETIME,
				address: ADDRESS,
				state: 'tombstone',
			});
			expect(await context.blobs.read(ADDRESS)).toBeUndefined();
		} finally {
			await context.close();
		}
	});

	test('a sealed capture pins blob bytes until its terminal transition', async () => {
		const context = await setup();
		try {
			const publication = request('pinned');
			await context.blobs.accept(publication, source('pinned'));
			const captures = createAuthorityCaptureManifestV1(
				createBunSqliteAdapter(context.raw),
			);
			const captureId = 'cccccccccccccccccccccccc';
			captures.start(captureId);
			expect(captures.advance(captureId)).toMatchObject({
				kind: 'advanced',
				caughtUp: true,
			});
			expect(captures.seal(captureId)).toMatchObject({ kind: 'sealed' });

			context.submit('tombstone');
			await context.blobs.sweepDebris();
			expect(
				(
					await readdir(join(context.root, 'blobs', 'content'), {
						recursive: true,
					})
				).some((entry) => entry.endsWith(publication.digest)),
			).toBe(true);

			captures.finish(captureId, 'cancelled');
			await context.blobs.sweepDebris();
			expect(
				(
					await readdir(join(context.root, 'blobs', 'content'), {
						recursive: true,
					})
				).some((entry) => entry.endsWith(publication.digest)),
			).toBe(false);
		} finally {
			await context.close();
		}
	});
});
