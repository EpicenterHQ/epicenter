/**
 * R2 Blob File Store Tests
 *
 * Verifies streaming blob persistence and the physical lifetime boundary.
 *
 * Key behaviors:
 * - Staged bytes promote into digest-verified content
 * - Paginated sweeps delete only unowned bytes
 * - One authority lifetime cannot read or sweep a sibling lifetime's bytes
 */
import { expect, test } from 'bun:test';

import { blobFileOwner } from '@epicenter/data/blob-v1';
import { sha256Hex } from '@epicenter/data/protocol/v1';

import { createR2BlobFileStore } from './blob-files-r2.js';

const ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'assets',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

function source(value: string): ReadableStream<Uint8Array> {
	return new Blob([value]).stream();
}

function setupBucket() {
	const objects = new Map<string, Uint8Array>();
	const bufferOf = (bytes: Uint8Array): ArrayBuffer =>
		Uint8Array.from(bytes).buffer;

	async function metadata(key: string): Promise<R2Object | null> {
		const bytes = objects.get(key);
		if (bytes === undefined) return null;
		const digest = await crypto.subtle.digest('SHA-256', bufferOf(bytes));
		return {
			key,
			version: 'test-version',
			size: bytes.byteLength,
			etag: 'test-etag',
			httpEtag: '"test-etag"',
			uploaded: new Date(0),
			checksums: { sha256: digest },
			storageClass: 'Standard',
			customMetadata: {},
			httpMetadata: {},
			writeHttpMetadata() {},
		} as unknown as R2Object;
	}

	const bucket = {
		async put(key: string, value: unknown) {
			const bytes = new Uint8Array(
				await new Response(value as BodyInit).arrayBuffer(),
			);
			objects.set(key, bytes);
			return metadata(key);
		},
		head: metadata,
		async get(key: string) {
			const object = await metadata(key);
			const bytes = objects.get(key);
			if (object === null || bytes === undefined) return null;
			return {
				...object,
				body: source(new TextDecoder().decode(bytes)),
				bodyUsed: false,
				arrayBuffer: async () => bufferOf(bytes),
				bytes: async () => bytes.slice(),
				blob: async () => new Blob([bufferOf(bytes)]),
				json: async () => JSON.parse(new TextDecoder().decode(bytes)),
				text: async () => new TextDecoder().decode(bytes),
			} as R2ObjectBody;
		},
		async delete(keys: string | string[]) {
			for (const key of Array.isArray(keys) ? keys : [keys])
				objects.delete(key);
		},
		async list(options: R2ListOptions = {}) {
			const keys = [...objects.keys()]
				.filter((key) => key.startsWith(options.prefix ?? ''))
				.sort();
			const start = Number(options.cursor ?? '0');
			const selected = keys.slice(start, start + 2);
			const listed = await Promise.all(
				selected.map(async (key) => {
					const object = await metadata(key);
					if (object === null) throw new Error('listed object disappeared');
					return object;
				}),
			);
			const next = start + selected.length;
			return {
				objects: listed,
				truncated: next < keys.length,
				...(next < keys.length ? { cursor: String(next) } : {}),
				delimitedPrefixes: [],
			};
		},
	} as unknown as R2Bucket;

	return { bucket, objects };
}

async function textOf(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

test('R2 blob files stream, verify, reopen, and sweep without skipping pages', async () => {
	const { bucket, objects } = setupBucket();
	const store = createR2BlobFileStore(bucket, 'owner-one', 'lifetime-one');
	const digest = sha256Hex('kept');
	const owner = blobFileOwner(ADDRESS, digest);
	const staged = await store.stage(source('kept'));
	expect(staged.digest).toBe(digest);
	await store.promote(staged, owner);
	expect(await textOf(await store.open(owner))).toBe('kept');

	await store.stage(source('staging-one'));
	await store.stage(source('staging-two'));
	await store.stage(source('staging-three'));
	const debrisDigest = sha256Hex('debris');
	const debris = blobFileOwner(
		{ ...ADDRESS, recordKey: 'bbbbbbbbbbbbbbbbbbbbbbbb' },
		debrisDigest,
	);
	await store.promote(await store.stage(source('debris')), debris);

	await store.sweepStaging();
	await store.sweepContent([owner]);
	expect([...objects.keys()]).toEqual([
		`data-authorities/owner-one/authorities/lifetime-one/blobs/content/${owner.ownerKey}/${owner.digest}`,
	]);
});

test("R2 blob sweeps cannot see or delete a sibling authority lifetime's bytes", async () => {
	const { bucket, objects } = setupBucket();
	const first = createR2BlobFileStore(bucket, 'owner-one', 'lifetime-one');
	const second = createR2BlobFileStore(bucket, 'owner-one', 'lifetime-two');
	const digest = sha256Hex('shared bytes');
	const owner = blobFileOwner(ADDRESS, digest);

	await first.promote(await first.stage(source('shared bytes')), owner);
	await expect(second.open(owner)).rejects.toThrow(
		'owned R2 blob bytes are missing',
	);
	await second.promote(await second.stage(source('shared bytes')), owner);
	await first.stage(source('first staging debris'));
	await second.stage(source('second staging debris'));

	await first.sweepStaging();
	await first.sweepContent([]);

	expect(await textOf(await second.open(owner))).toBe('shared bytes');
	expect(
		[...objects.keys()].every((key) =>
			key.startsWith(
				'data-authorities/owner-one/authorities/lifetime-two/blobs/',
			),
		),
	).toBe(true);
	expect([...objects.keys()].some((key) => key.includes('/staging/'))).toBe(
		true,
	);
});
