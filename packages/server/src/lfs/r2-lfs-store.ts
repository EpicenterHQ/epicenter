/**
 * Git LFS objects in R2, for the Worker: `lfs/<repository id>/<oid>`.
 *
 * Clients move bytes straight to and from R2 through presigned URLs (spike
 * 5), past the Worker's request size limit. An upload URL signs `host`,
 * `content-length`, `if-none-match: *` and `x-amz-checksum-sha256`, so R2
 * itself refuses other bytes (400 `BadDigest`), another key or a missing
 * header (403), a second write (412) and a stale URL (403). It must not sign
 * `x-amz-content-sha256`: R2 refuses every presigned URL that does.
 *
 * Verifying is one `head()`: the stored size, and the sha256 R2 recorded
 * from the signed checksum header, must equal the pointer's. The Worker
 * never hashes the bytes, and an object stored without a sha256 checksum is
 * never verified.
 *
 * `put` and `get` stream through the Worker over the binding, for a client
 * that uses this server's own object routes; R2 checks `put`'s sha256. The
 * body must have a known length (a request with `content-length`).
 */
import { AwsClient } from 'aws4fetch';
import {
	LFS_OID,
	type LfsAction,
	type LfsObject,
	type LfsPutResult,
	type LfsStore,
} from './lfs-store.js';

/** The slice of an R2 bucket binding this store calls. */
export type R2LfsBucket = {
	head(
		key: string,
	): Promise<{ size: number; checksums: { sha256?: ArrayBuffer } } | null>;
	get(
		key: string,
	): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
	put(
		key: string,
		body: ReadableStream<Uint8Array>,
		options: { sha256: string },
	): Promise<{ size: number } | null>;
};

/** R2's S3 endpoint for presigning: the account, the bucket's name, and an S3 key pair. */
export type R2Presigner = {
	accountId: string;
	bucketName: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** Seconds a presigned URL stays usable; 900 by default. */
	expiresIn?: number;
};

const REPOSITORY_ID = /^[A-Za-z0-9._-]{1,100}$/;

const hex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('');

/** The base64 of the digest a hex oid names, as `x-amz-checksum-sha256` carries it. */
export function checksumHeader(oid: string): string {
	let binary = '';
	for (let at = 0; at < oid.length; at += 2)
		binary += String.fromCharCode(Number.parseInt(oid.slice(at, at + 2), 16));
	return btoa(binary);
}

export function createR2LfsStore({
	bucket,
	presigner,
}: {
	bucket: R2LfsBucket;
	/** Without it, clients upload and download through this server's routes. */
	presigner?: R2Presigner;
}): LfsStore {
	const keyOf = (repositoryId: string, oid: string) => {
		if (!REPOSITORY_ID.test(repositoryId) || !LFS_OID.test(oid))
			throw new Error('not an LFS object address');
		return `lfs/${repositoryId}/${oid}`;
	};
	/** The stored size of `oid` when R2 recorded its sha256 as `oid`, else null. */
	const verifiedSize = async (repositoryId: string, oid: string) => {
		const found = await bucket.head(keyOf(repositoryId, oid));
		const sha256 = found?.checksums.sha256;
		return found && sha256 && hex(sha256) === oid ? found.size : null;
	};

	const store: LfsStore = {
		async verified(repositoryId, { oid, size }) {
			if (!LFS_OID.test(oid)) return false;
			return (await verifiedSize(repositoryId, oid)) === size;
		},
		async put(repositoryId, oid, body, size): Promise<LfsPutResult> {
			const key = keyOf(repositoryId, oid);
			const existing = await verifiedSize(repositoryId, oid);
			if (existing !== null) {
				await body.cancel();
				return size === undefined || size === existing
					? { ok: true, size: existing }
					: { ok: false, reason: 'size-mismatch' };
			}
			let stored: { size: number } | null;
			try {
				stored = await bucket.put(key, body, { sha256: oid });
			} catch (cause) {
				// R2 refuses a put whose bytes do not hash to the given sha256.
				if (/sha-?256|checksum|digest|hash/i.test(String(cause)))
					return { ok: false, reason: 'hash-mismatch' };
				throw cause;
			}
			if (stored === null) throw new Error(`R2 did not store ${key}`);
			// The bytes are `oid`'s, so they stay; only the declared length was wrong.
			if (size !== undefined && stored.size !== size)
				return { ok: false, reason: 'size-mismatch' };
			return { ok: true, size: stored.size };
		},
		async get(repositoryId, oid) {
			const found = await bucket.get(keyOf(repositoryId, oid));
			return found ? { size: found.size, body: found.body } : null;
		},
	};
	if (!presigner) return store;

	const { accountId, bucketName, accessKeyId, secretAccessKey } = presigner;
	const expiresIn = presigner.expiresIn ?? 900;
	const aws = new AwsClient({
		accessKeyId,
		secretAccessKey,
		service: 's3',
		region: 'auto',
	});
	store.presign = async (
		repositoryId: string,
		{ oid, size }: LfsObject,
		operation: 'upload' | 'download',
	): Promise<LfsAction> => {
		const url = new URL(
			`https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${keyOf(repositoryId, oid)}`,
		);
		url.searchParams.set('X-Amz-Expires', String(expiresIn));
		const header: Record<string, string> =
			operation === 'upload'
				? { 'x-amz-checksum-sha256': checksumHeader(oid), 'if-none-match': '*' }
				: {};
		const signed = await aws.sign(url, {
			method: operation === 'upload' ? 'PUT' : 'GET',
			headers:
				operation === 'upload'
					? { ...header, 'content-length': String(size) }
					: {},
			aws: { signQuery: true, allHeaders: true },
		});
		return { href: signed.url, header, expiresIn };
	};
	return store;
}
