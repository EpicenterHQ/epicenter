/**
 * LFS bytes in an R2 bucket, at `objects/<oid>`, written against the few
 * calls it uses so no host needs Cloudflare's types. R2 checks the bytes
 * itself (`put` with `sha256`, error 10037 on a mismatch, at almost no
 * Worker CPU: deployed spike 4) and never overwrites (`onlyIf:
 * { etagDoesNotMatch: '*' }`). Deployed R2 answers an existing key with
 * `null` and local R2 throws, so either is confirmed by `head`'s checksum.
 * Per-key contention (10058) is retried while the body is unread. Not
 * deployed in this phase: checked against a fake bucket modelling those
 * semantics (`lfs-store.test.ts`), since Miniflare does not resolve here.
 */
import { Ok } from 'wellcrafted/result';
import { LFS_OID, type LfsStore, LfsStoreError } from './lfs-store.js';

/** Only the R2 surface used by the byte store; hosts need no Cloudflare types. */
export type R2Bucket = {
	put(
		key: string,
		body: ReadableStream<Uint8Array>,
		options: { sha256: string; onlyIf: { etagDoesNotMatch: '*' } },
	): Promise<unknown | null>;
	head(key: string): Promise<{
		size: number;
		checksums?: { sha256?: ArrayBuffer | Uint8Array | string };
	} | null>;
	get(
		key: string,
	): Promise<{ body?: ReadableStream<Uint8Array>; size: number } | null>;
};

type Fixed = { readable: ReadableStream<Uint8Array>; done: Promise<void> };

function workerFixedLength(
	size: number,
	body: ReadableStream<Uint8Array>,
): Fixed {
	const Constructor = (
		globalThis as unknown as {
			FixedLengthStream: new (
				size: number,
			) => {
				readable: ReadableStream<Uint8Array>;
				writable: WritableStream<Uint8Array>;
			};
		}
	).FixedLengthStream;
	const fixed = new Constructor(size);
	return { readable: fixed.readable, done: body.pipeTo(fixed.writable) };
}

const checksum = (value: ArrayBuffer | Uint8Array | string | undefined) =>
	typeof value === 'string'
		? value.toLowerCase()
		: value === undefined
			? null
			: Array.from(new Uint8Array(value), (byte) =>
					byte.toString(16).padStart(2, '0'),
				).join('');

/** R2 checks the SHA-256 while consuming a fixed-length body; the conditional put never replaces bytes. */
export function createR2LfsStore(
	bucket: R2Bucket,
	{
		fixedLength = workerFixedLength,
	}: {
		fixedLength?: (size: number, body: ReadableStream<Uint8Array>) => Fixed;
	} = {},
): LfsStore {
	const key = (oid: string) => `objects/${oid}`;
	const confirmed = async (oid: string) =>
		checksum((await bucket.head(key(oid)))?.checksums?.sha256) === oid;
	return {
		async has(oid) {
			return LFS_OID.test(oid) && (await bucket.head(key(oid))) !== null;
		},
		async get(oid) {
			if (!LFS_OID.test(oid)) return null;
			const item = await bucket.get(key(oid));
			return item?.body === undefined
				? null
				: { body: item.body, size: item.size };
		},
		async put(oid, size, body) {
			if (!LFS_OID.test(oid) || !Number.isSafeInteger(size) || size < 0) {
				await body.cancel().catch(() => {});
				return LfsStoreError.Mismatch();
			}
			let fixed: Fixed;
			try {
				fixed = fixedLength(size, body);
			} catch (cause) {
				return LfsStoreError.Failed({ cause });
			}
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					const written = await bucket.put(key(oid), fixed.readable, {
						sha256: oid,
						onlyIf: { etagDoesNotMatch: '*' },
					});
					if (written === null) {
						await fixed.readable.cancel().catch(() => {});
						await fixed.done.catch(() => {});
						return (await confirmed(oid))
							? Ok('present')
							: LfsStoreError.Failed({
									cause: new Error('R2 did not confirm the existing checksum'),
								});
					}
					await fixed.done;
					return Ok('stored');
				} catch (cause) {
					const message = String(cause);
					if (
						message.includes('10058') &&
						attempt < 2 &&
						!fixed.readable.locked
					) {
						await new Promise((resolve) =>
							setTimeout(resolve, attempt === 0 ? 250 : 750),
						);
						continue;
					}
					if (!fixed.readable.locked)
						await fixed.readable.cancel().catch(() => {});
					if (message.includes('10037')) {
						await fixed.done.catch(() => {});
						return LfsStoreError.Mismatch();
					}
					if (await confirmed(oid).catch(() => false)) {
						await fixed.done.catch(() => {});
						return Ok('present');
					}
					await fixed.done.catch(() => {});
					return LfsStoreError.Failed({ cause });
				}
			}
			return LfsStoreError.Failed({ cause: new Error('R2 retries exhausted') });
		},
	};
}
