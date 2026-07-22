import { blobFileOwner } from '@epicenter/data/blob-v1';
import type { RecordAddress } from '@epicenter/data/protocol/v1';
import { bytesToHex } from '@noble/hashes/utils.js';

import { r2DataBackupPrefix } from './backup-r2-paths.js';

export type R2BackupBlobReference = {
	address: RecordAddress;
	digest: string;
};

function checksumHex(object: R2Object): string | undefined {
	const checksum = object.checksums.sha256;
	return checksum === undefined
		? undefined
		: bytesToHex(new Uint8Array(checksum));
}

/** Raw immutable blob owner for one Cloudflare Backup. */
export function createR2BackupBlobStore(
	bucket: R2Bucket,
	ownerStorageKey: string,
	backupId: string,
) {
	const contentPrefix = `${r2DataBackupPrefix(ownerStorageKey, backupId)}blobs/content/`;

	function contentKey(address: RecordAddress, digest: string): string {
		const owner = blobFileOwner(address, digest);
		return `${contentPrefix}${owner.ownerKey}/${owner.digest}`;
	}

	async function copy(
		address: RecordAddress,
		digest: string,
		source: ReadableStream<Uint8Array>,
	): Promise<void> {
		// readCapture supplies an R2 body whose stream carries a runtime-known
		// length. TransformStream would erase that metadata, so copy it directly.
		const stored = await bucket.put(contentKey(address, digest), source, {
			sha256: digest,
		});
		if (stored === null || checksumHex(stored) !== digest) {
			throw new Error('Backup blob bytes do not match their digest');
		}
	}

	async function open(
		address: RecordAddress,
		digest: string,
	): Promise<ReadableStream<Uint8Array>> {
		const object = await bucket.get(contentKey(address, digest));
		if (object === null || !('body' in object)) {
			throw new Error('Backup blob bytes are missing');
		}
		if (checksumHex(object) !== digest) {
			throw new Error('Backup blob failed digest verification');
		}
		return object.body;
	}

	async function seal(
		expected: Iterable<R2BackupBlobReference>,
	): Promise<void> {
		let expectedBlobCount = 0;
		for (const reference of expected) {
			const object = await bucket.head(
				contentKey(reference.address, reference.digest),
			);
			if (object === null || checksumHex(object) !== reference.digest) {
				throw new Error('Backup blob membership is incomplete');
			}
			expectedBlobCount += 1;
		}
		let count = 0;
		let cursor: string | undefined;
		for (;;) {
			const page = await bucket.list({
				prefix: contentPrefix,
				...(cursor === undefined ? {} : { cursor }),
			});
			for (const object of page.objects) {
				const relative = object.key.slice(contentPrefix.length);
				const [ownerKey, digest, extra] = relative.split('/');
				if (
					extra !== undefined ||
					ownerKey === undefined ||
					digest === undefined ||
					!/^[a-f0-9]{64}$/u.test(ownerKey) ||
					!/^[a-f0-9]{64}$/u.test(digest) ||
					checksumHex(object) !== digest
				) {
					throw new Error('Backup contains an unexpected blob entry');
				}
				count += 1;
			}
			if (!page.truncated) break;
			if (page.cursor === undefined) {
				throw new Error('R2 omitted a truncated Backup blob cursor');
			}
			cursor = page.cursor;
		}
		if (count !== expectedBlobCount) {
			throw new Error('Backup blob membership is incomplete');
		}
	}

	return Object.freeze({ copy, open, seal });
}
