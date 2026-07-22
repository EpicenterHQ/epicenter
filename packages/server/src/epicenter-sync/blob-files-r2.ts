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

export function r2DataOwnerPrefix(ownerStorageKey: string): string {
	return `data-authorities/${encodeURIComponent(ownerStorageKey)}/`;
}

function r2AuthorityLifetimePrefix(
	ownerStorageKey: string,
	authorityLifetime: string,
): string {
	return `${r2DataOwnerPrefix(ownerStorageKey)}authorities/${encodeURIComponent(authorityLifetime)}/`;
}

function r2BlobContentKey(
	ownerStorageKey: string,
	authorityLifetime: string,
	owner: OwnedBlobFile,
): string {
	if (!/^[a-f0-9]{64}$/u.test(owner.ownerKey)) {
		throw new Error('invalid R2 blob owner');
	}
	if (!/^[a-f0-9]{64}$/u.test(owner.digest)) {
		throw new Error('invalid R2 blob digest');
	}
	return `${r2AuthorityLifetimePrefix(ownerStorageKey, authorityLifetime)}blobs/content/${owner.ownerKey}/${owner.digest}`;
}

async function deletePrefix(bucket: R2Bucket, prefix: string): Promise<void> {
	while (true) {
		const page = await bucket.list({ prefix });
		if (page.objects.length === 0) return;
		await bucket.delete(page.objects.map((object) => object.key));
	}
}

/** Delete every R2 object owned by one principal DataAuthority. */
export async function deleteR2BlobOwner(
	bucket: R2Bucket,
	ownerStorageKey: string,
): Promise<void> {
	await deletePrefix(bucket, r2DataOwnerPrefix(ownerStorageKey));
}

/** Delete one unpublished or retired authority lifetime without touching siblings. */
export async function deleteR2AuthorityLifetime(
	bucket: R2Bucket,
	ownerStorageKey: string,
	authorityLifetime: string,
): Promise<void> {
	await deletePrefix(
		bucket,
		r2AuthorityLifetimePrefix(ownerStorageKey, authorityLifetime),
	);
}

/** Retain only the canonical active lifetime after a crash or completed Restore. */
export async function sweepR2AuthorityLifetimes(
	bucket: R2Bucket,
	ownerStorageKey: string,
	activeAuthorityLifetime: string,
): Promise<void> {
	const authoritiesPrefix = `${r2DataOwnerPrefix(ownerStorageKey)}authorities/`;
	const activePrefix = r2AuthorityLifetimePrefix(
		ownerStorageKey,
		activeAuthorityLifetime,
	);
	let cursor: string | undefined;
	for (;;) {
		const page = await bucket.list({
			prefix: authoritiesPrefix,
			...(cursor === undefined ? {} : { cursor }),
		});
		const debris = page.objects
			.map((object) => object.key)
			.filter((key) => !key.startsWith(activePrefix));
		if (debris.length > 0) {
			await bucket.delete(debris);
			cursor = undefined;
			continue;
		}
		if (!page.truncated) return;
		if (page.cursor === undefined) {
			throw new Error('R2 omitted an authority lifetime sweep cursor');
		}
		cursor = page.cursor;
	}
}

/** Copy already digest-verified R2 bytes into an unpublished authority lifetime. */
export async function copyR2AuthorityBlob(
	bucket: R2Bucket,
	ownerStorageKey: string,
	authorityLifetime: string,
	owner: OwnedBlobFile,
	source: ReadableStream<Uint8Array>,
): Promise<void> {
	const destination = r2BlobContentKey(
		ownerStorageKey,
		authorityLifetime,
		owner,
	);
	const existing = await bucket.head(destination);
	if (existing !== null) {
		if (checksumHex(existing) !== owner.digest) {
			throw new Error('restored R2 blob failed digest verification');
		}
		return;
	}
	const stored = await bucket.put(destination, source, {
		sha256: owner.digest,
	});
	if (stored === null || checksumHex(stored) !== owner.digest) {
		throw new Error('R2 did not verify restored blob bytes');
	}
}

/** Verify exact physical membership before an unpublished lifetime can activate. */
export async function sealR2AuthorityBlobs(
	bucket: R2Bucket,
	ownerStorageKey: string,
	authorityLifetime: string,
	expectedBlobCount: number,
): Promise<void> {
	if (!Number.isSafeInteger(expectedBlobCount) || expectedBlobCount < 0) {
		throw new RangeError(
			'restored R2 blob count must be a non-negative integer',
		);
	}
	const blobsPrefix = `${r2AuthorityLifetimePrefix(ownerStorageKey, authorityLifetime)}blobs/`;
	let count = 0;
	let cursor: string | undefined;
	for (;;) {
		const page = await bucket.list({
			prefix: blobsPrefix,
			...(cursor === undefined ? {} : { cursor }),
		});
		for (const object of page.objects) {
			const [kind, ownerKey, digest, extra] = object.key
				.slice(blobsPrefix.length)
				.split('/');
			if (
				kind !== 'content' ||
				extra !== undefined ||
				ownerKey === undefined ||
				digest === undefined ||
				!/^[a-f0-9]{64}$/u.test(ownerKey) ||
				!/^[a-f0-9]{64}$/u.test(digest) ||
				checksumHex(object) !== digest
			) {
				throw new Error('restored authority contains an unexpected R2 blob');
			}
			count += 1;
		}
		if (!page.truncated) break;
		if (page.cursor === undefined) {
			throw new Error('R2 omitted a restored authority blob cursor');
		}
		cursor = page.cursor;
	}
	if (count !== expectedBlobCount) {
		throw new Error('restored authority R2 blob membership is incomplete');
	}
}

/** R2 implementation bound to one principal authority lifetime. */
export function createR2BlobFileStore(
	bucket: R2Bucket,
	ownerStorageKey: string,
	authorityLifetime: string,
): BlobFileStore<ReadableStream<Uint8Array>, ReadableStream<Uint8Array>> {
	const root = `${r2AuthorityLifetimePrefix(ownerStorageKey, authorityLifetime)}blobs`;
	const stagingPrefix = `${root}/staging/`;
	const contentPrefix = `${root}/content/`;

	function stagingKey(staged: StagedBlob): string {
		if (!/^[0-9a-f-]{36}$/u.test(staged.id)) {
			throw new Error('invalid R2 staged blob identity');
		}
		return `${stagingPrefix}${staged.id}`;
	}

	function contentKey(owner: OwnedBlobFile): string {
		return r2BlobContentKey(ownerStorageKey, authorityLifetime, owner);
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
		sweepStaging: () => deletePrefix(bucket, stagingPrefix),
		sweepContent,
	};
}
