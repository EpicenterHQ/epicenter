import type {
	BlobFileStore,
	OwnedBlobFile,
	StagedBlob,
} from '@epicenter/data/blob-v1';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

function checksumHex(object: R2Object): string | undefined {
	const checksum = object.checksums.sha256;
	return checksum === undefined
		? undefined
		: bytesToHex(new Uint8Array(checksum));
}

/** R2 implementation used by one principal DataAuthority Durable Object. */
export function createR2BlobFileStore(
	bucket: R2Bucket,
	ownerStorageKey: string,
): BlobFileStore<ReadableStream<Uint8Array>, ReadableStream<Uint8Array>> {
	const root = `data-authorities/${encodeURIComponent(ownerStorageKey)}/blobs`;
	const stagingPrefix = `${root}/staging/`;
	const contentPrefix = `${root}/content/`;

	function stagingKey(staged: StagedBlob): string {
		if (!/^[0-9a-f-]{36}$/u.test(staged.id)) {
			throw new Error('invalid R2 staged blob identity');
		}
		return `${stagingPrefix}${staged.id}`;
	}

	function contentKey(owner: OwnedBlobFile): string {
		if (!/^[a-f0-9]{64}$/u.test(owner.ownerKey)) {
			throw new Error('invalid R2 blob owner');
		}
		if (!/^[a-f0-9]{64}$/u.test(owner.digest)) {
			throw new Error('invalid R2 blob digest');
		}
		return `${contentPrefix}${owner.ownerKey}/${owner.digest}`;
	}

	async function stage(
		source: ReadableStream<Uint8Array>,
	): Promise<StagedBlob> {
		const id = crypto.randomUUID();
		const hasher = sha256.create();
		const hashing = new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				if (!(chunk instanceof Uint8Array)) {
					throw new TypeError('R2 blob source yielded a non-byte chunk');
				}
				hasher.update(chunk);
				controller.enqueue(chunk);
			},
		});
		const stored = await bucket.put(
			`${stagingPrefix}${id}`,
			source.pipeThrough(hashing),
		);
		if (stored === null) throw new Error('R2 refused blob staging');
		return { id, digest: bytesToHex(hasher.digest()) };
	}

	async function promote(
		staged: StagedBlob,
		owner: OwnedBlobFile,
	): Promise<void> {
		if (staged.digest !== owner.digest) {
			throw new Error('staged R2 blob digest does not match its owner');
		}
		const destination = contentKey(owner);
		const existing = await bucket.head(destination);
		if (existing !== null) {
			if (checksumHex(existing) !== owner.digest) {
				throw new Error('owned R2 blob failed digest verification');
			}
			await bucket.delete(stagingKey(staged));
			return;
		}
		const stagedObject = await bucket.get(stagingKey(staged));
		if (stagedObject === null || !('body' in stagedObject)) {
			throw new Error('staged R2 blob bytes are missing');
		}
		const stored = await bucket.put(destination, stagedObject.body, {
			sha256: owner.digest,
		});
		if (stored === null || checksumHex(stored) !== owner.digest) {
			throw new Error('R2 did not verify promoted blob bytes');
		}
		await bucket.delete(stagingKey(staged));
	}

	async function open(
		owner: OwnedBlobFile,
	): Promise<ReadableStream<Uint8Array>> {
		const object = await bucket.get(contentKey(owner));
		if (object === null || !('body' in object)) {
			throw new Error('owned R2 blob bytes are missing');
		}
		if (checksumHex(object) !== owner.digest) {
			throw new Error('owned R2 blob failed digest verification');
		}
		return object.body;
	}

	async function deletePrefix(prefix: string): Promise<void> {
		while (true) {
			const page = await bucket.list({ prefix });
			if (page.objects.length === 0) return;
			if (page.objects.length > 0) {
				await bucket.delete(page.objects.map((object) => object.key));
			}
		}
	}

	async function sweepContent(owned: readonly OwnedBlobFile[]): Promise<void> {
		const retained = new Set(owned.map(contentKey));
		let cursor: string | undefined;
		while (true) {
			const page = await bucket.list({
				prefix: contentPrefix,
				...(cursor ? { cursor } : {}),
			});
			const debris = page.objects
				.map((object) => object.key)
				.filter((key) => !retained.has(key));
			if (debris.length > 0) {
				await bucket.delete(debris);
				cursor = undefined;
				continue;
			}
			if (!page.truncated) return;
			cursor = page.cursor;
		}
	}

	return {
		stage,
		promote,
		open,
		sweepStaging: () => deletePrefix(stagingPrefix),
		sweepContent,
	};
}
