import { expect, test } from 'bun:test';

import { blobFileOwner } from '@epicenter/data/blob-v1';
import { sha256Hex } from '@epicenter/data/protocol/v1';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { createR2BackupBlobStore } from './backup-files-r2.js';

const ADDRESS = {
	namespace: 'so.epicenter.notes',
	collection: 'notes',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
};
const BACKUP_ID = 'b'.repeat(24);

function source(value: string): ReadableStream<Uint8Array> {
	return new Blob([value]).stream();
}

function setupBucket() {
	const objects = new Map<
		string,
		{ bytes: Uint8Array; checksum: ArrayBuffer }
	>();
	const bucket = {
		async put(
			key: string,
			value: ReadableStream<Uint8Array>,
			options?: R2PutOptions,
		) {
			const bytes = new Uint8Array(await new Response(value).arrayBuffer());
			const digest = bytesToHex(sha256(bytes));
			const checksum = Uint8Array.from(digest.match(/.{2}/gu) ?? [], (hex) =>
				Number.parseInt(hex, 16),
			).buffer;
			if (options?.sha256 !== undefined && options.sha256 !== digest) {
				return null;
			}
			objects.set(key, { bytes, checksum });
			return { key, checksums: { sha256: checksum } } as R2Object;
		},
		async get(key: string) {
			const object = objects.get(key);
			return object === undefined
				? null
				: ({
						key,
						checksums: { sha256: object.checksum },
						body: new Blob([
							object.bytes.slice().buffer as ArrayBuffer,
						]).stream(),
					} as R2ObjectBody);
		},
		async head(key: string) {
			const object = objects.get(key);
			return object === undefined
				? null
				: ({
						key,
						checksums: { sha256: object.checksum },
					} as R2Object);
		},
		async list({ prefix = '', cursor }: R2ListOptions = {}) {
			const keys = [...objects.keys()]
				.filter((key) => key.startsWith(prefix))
				.sort();
			const start = cursor === undefined ? 0 : Number(cursor);
			const page = keys.slice(start, start + 2);
			return {
				objects: page.map((key) => ({
					key,
					checksums: { sha256: objects.get(key)?.checksum },
				})),
				truncated: start + page.length < keys.length,
				cursor: String(start + page.length),
			};
		},
	} as unknown as R2Bucket;
	return { bucket, objects };
}

test('R2 Backup blobs copy, verify, page, reopen, and seal', async () => {
	const { bucket, objects } = setupBucket();
	const store = createR2BackupBlobStore(bucket, 'owner-one', BACKUP_ID);
	const firstDigest = sha256Hex('first');
	const secondAddress = { ...ADDRESS, recordKey: 'b'.repeat(24) };
	const secondDigest = sha256Hex('second');
	const thirdAddress = { ...ADDRESS, recordKey: 'c'.repeat(24) };
	const thirdDigest = sha256Hex('third');

	await store.copy(ADDRESS, firstDigest, source('first'));
	await store.copy(secondAddress, secondDigest, source('second'));
	await store.copy(thirdAddress, thirdDigest, source('third'));
	await store.seal([
		{ address: ADDRESS, digest: firstDigest },
		{ address: secondAddress, digest: secondDigest },
		{ address: thirdAddress, digest: thirdDigest },
	]);
	expect(
		await new Response(await store.open(ADDRESS, firstDigest)).text(),
	).toBe('first');
	expect(objects.size).toBe(3);
});

test('R2 Backup blobs refuse corrupt bytes and incomplete membership', async () => {
	const { bucket, objects } = setupBucket();
	const store = createR2BackupBlobStore(bucket, 'owner-one', BACKUP_ID);
	const digest = sha256Hex('expected');
	await expect(store.copy(ADDRESS, digest, source('wrong'))).rejects.toThrow(
		'bytes do not match',
	);
	await expect(store.seal([{ address: ADDRESS, digest }])).rejects.toThrow(
		'membership is incomplete',
	);

	const owner = blobFileOwner(ADDRESS, digest);
	const key = `data-authorities/owner-one/backups/${BACKUP_ID}/blobs/content/${owner.ownerKey}/${owner.digest}`;
	const badChecksum = new Uint8Array(32).buffer;
	objects.set(key, {
		bytes: new TextEncoder().encode('expected'),
		checksum: badChecksum,
	});
	await expect(store.seal([{ address: ADDRESS, digest }])).rejects.toThrow(
		'membership is incomplete',
	);
	await expect(store.open(ADDRESS, digest)).rejects.toThrow(
		'digest verification',
	);
});

test('R2 Backup blobs refuse extra and malformed physical entries', async () => {
	const { bucket, objects } = setupBucket();
	const store = createR2BackupBlobStore(bucket, 'owner-one', BACKUP_ID);
	const digest = sha256Hex('kept');
	await store.copy(ADDRESS, digest, source('kept'));
	const arbitraryChecksum = new Uint8Array(32).buffer;
	objects.set(
		`data-authorities/owner-one/backups/${BACKUP_ID}/blobs/content/unexpected`,
		{ bytes: new Uint8Array(), checksum: arbitraryChecksum },
	);
	await expect(store.seal([{ address: ADDRESS, digest }])).rejects.toThrow(
		'unexpected blob entry',
	);
});

test('R2 Backup seal cannot substitute a valid orphan for a missing reference', async () => {
	const { bucket } = setupBucket();
	const store = createR2BackupBlobStore(bucket, 'owner-one', BACKUP_ID);
	const orphanAddress = { ...ADDRESS, recordKey: 'd'.repeat(24) };
	const orphanDigest = sha256Hex('orphan');
	await store.copy(orphanAddress, orphanDigest, source('orphan'));

	await expect(
		store.seal([{ address: ADDRESS, digest: sha256Hex('missing') }]),
	).rejects.toThrow('membership is incomplete');
});
