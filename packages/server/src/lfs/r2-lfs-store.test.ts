/**
 * The R2 LFS store against an in-memory bucket that behaves as R2 does for
 * these calls: `put` with a `sha256` refuses other bytes and records the
 * checksum, and `head` reports it. The presigned URLs are checked for what
 * spike 5 showed R2 enforces; R2 itself is exercised by the deployed spike.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { answerBatch } from '../routes/lfs.js';
import {
	checksumHeader,
	createR2LfsStore,
	type R2LfsBucket,
} from './r2-lfs-store.js';

type Stored = { bytes: Uint8Array; sha256?: ArrayBuffer };

function memoryBucket() {
	const objects = new Map<string, Stored>();
	const bucket: R2LfsBucket = {
		async head(key) {
			const found = objects.get(key);
			return found
				? {
						size: found.bytes.length,
						checksums: found.sha256 ? { sha256: found.sha256 } : {},
					}
				: null;
		},
		async get(key) {
			const found = objects.get(key);
			return found
				? { size: found.bytes.length, body: stream(found.bytes) }
				: null;
		},
		async put(key, body, { sha256 }) {
			const bytes = new Uint8Array(await new Response(body).arrayBuffer());
			const digest = createHash('sha256').update(bytes).digest();
			if (digest.toString('hex') !== sha256)
				throw new Error(
					'put: The SHA-256 checksum you specified did not match what we received.',
				);
			objects.set(key, {
				bytes,
				sha256: digest.buffer.slice(
					digest.byteOffset,
					digest.byteOffset + digest.byteLength,
				),
			});
			return { size: bytes.length };
		},
	};
	return { bucket, objects };
}

const stream = (bytes: Uint8Array) =>
	new Blob([bytes as Uint8Array<ArrayBuffer>]).stream();
const audio = new TextEncoder().encode(
	'not really audio, but bytes\n'.repeat(50),
);
const oid = createHash('sha256').update(audio).digest('hex');
const REPO = 'r0123456789abcde';
const presigner = {
	accountId: 'acct0000000000000000000000000000',
	bucketName: 'epicenter-spike8-test-r2',
	accessKeyId: 'AKIDEXAMPLE',
	secretAccessKey: 'secret-example',
};

describe('R2 LFS store', () => {
	test('verified needs the size and the sha256 R2 recorded', async () => {
		const { bucket, objects } = memoryBucket();
		const store = createR2LfsStore({ bucket });
		expect(await store.verified(REPO, { oid, size: audio.length })).toBe(false);
		expect(await store.put(REPO, oid, stream(audio), audio.length)).toEqual({
			ok: true,
			size: audio.length,
		});
		expect(await store.verified(REPO, { oid, size: audio.length })).toBe(true);
		expect(await store.verified(REPO, { oid, size: audio.length + 1 })).toBe(
			false,
		);
		// An object with no sha256 checksum (a PUT that did not sign one) is never verified.
		objects.set(`lfs/${REPO}/${oid}`, { bytes: audio });
		expect(await store.verified(REPO, { oid, size: audio.length })).toBe(false);
		// Objects are per repository.
		expect(
			await store.verified('rabcdefabcdefabcd', { oid, size: audio.length }),
		).toBe(false);
	});

	test('put refuses bytes that are not the oid, and stores nothing', async () => {
		const { bucket, objects } = memoryBucket();
		const store = createR2LfsStore({ bucket });
		const other = new Uint8Array(audio);
		other[0] = 0;
		expect(await store.put(REPO, oid, stream(other), other.length)).toEqual({
			ok: false,
			reason: 'hash-mismatch',
		});
		expect(objects.size).toBe(0);
	});

	test('put reports a wrong declared length, and an existing object is kept', async () => {
		const { bucket } = memoryBucket();
		const store = createR2LfsStore({ bucket });
		expect(await store.put(REPO, oid, stream(audio), audio.length - 1)).toEqual(
			{
				ok: false,
				reason: 'size-mismatch',
			},
		);
		expect(await store.put(REPO, oid, stream(audio))).toEqual({
			ok: true,
			size: audio.length,
		});
		const back = await store.get(REPO, oid);
		expect(back?.size).toBe(audio.length);
		expect(
			new Uint8Array(await new Response(back?.body).arrayBuffer()),
		).toEqual(audio);
		expect(await store.get(REPO, 'a'.repeat(64))).toBeNull();
	});

	test('an upload URL signs the checksum, the length and if-none-match, never the content sha256', async () => {
		const store = createR2LfsStore({
			bucket: memoryBucket().bucket,
			presigner,
		});
		const action = await store.presign?.(REPO, { oid, size: 1234 }, 'upload');
		if (!action) throw new Error('no presign');
		const url = new URL(action.href);
		expect(url.origin).toBe(
			`https://${presigner.accountId}.r2.cloudflarestorage.com`,
		);
		expect(url.pathname).toBe(`/${presigner.bucketName}/lfs/${REPO}/${oid}`);
		expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
			'content-length;host;if-none-match;x-amz-checksum-sha256',
		);
		expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
		expect(url.searchParams.get('X-Amz-Credential')).toStartWith(
			`${presigner.accessKeyId}/`,
		);
		expect(url.searchParams.has('X-Amz-Signature')).toBe(true);
		expect(action.header).toEqual({
			'x-amz-checksum-sha256': Buffer.from(oid, 'hex').toString('base64'),
			'if-none-match': '*',
		});
		expect(action.expiresIn).toBe(900);
	});

	test('a download URL is a signed GET with no headers to send', async () => {
		const store = createR2LfsStore({
			bucket: memoryBucket().bucket,
			presigner,
		});
		const action = await store.presign?.(REPO, { oid, size: 1 }, 'download');
		if (!action) throw new Error('no presign');
		expect(new URL(action.href).searchParams.get('X-Amz-SignedHeaders')).toBe(
			'host',
		);
		expect(action.header).toEqual({});
	});

	test('without a presigner, clients use the server routes', () => {
		expect(
			createR2LfsStore({ bucket: memoryBucket().bucket }).presign,
		).toBeUndefined();
	});

	test('checksumHeader is the base64 of the digest', () => {
		expect(checksumHeader(oid)).toBe(
			createHash('sha256').update(audio).digest('base64'),
		);
	});
});

type BatchAnswer = {
	objects: {
		oid: string;
		size: number;
		authenticated?: boolean;
		actions?: Record<string, { href: string; header?: Record<string, string> }>;
	}[];
};
const batch = async (response: Response) =>
	(await response.json()) as BatchAnswer;
const actionOf = (answer: BatchAnswer, name: string) => {
	const action = answer.objects[0]?.actions?.[name];
	if (!action) throw new Error(`no ${name} action`);
	return action;
};

describe('the batch API over a presigning store', () => {
	const remote = 'https://spike.example/git/spike8wong01/demo.git';

	test('an upload gets a presigned PUT and nothing else; a stored object needs nothing', async () => {
		const { bucket } = memoryBucket();
		const store = createR2LfsStore({ bucket, presigner });
		const before = await batch(
			await answerBatch(
				store,
				REPO,
				{ operation: 'upload', objects: [{ oid, size: audio.length }] },
				remote,
			),
		);
		expect(new URL(actionOf(before, 'upload').href).host).toBe(
			`${presigner.accountId}.r2.cloudflarestorage.com`,
		);
		expect(actionOf(before, 'upload').header?.['if-none-match']).toBe('*');
		// Presigned: no credential goes to R2, and no verify action, since R2
		// stores only the signed checksum's bytes and pointers are checked again.
		expect(before.objects[0]?.authenticated).toBe(true);
		expect(Object.keys(before.objects[0]?.actions ?? {})).toEqual(['upload']);

		await store.put(REPO, oid, stream(audio), audio.length);
		const after = await batch(
			await answerBatch(
				store,
				REPO,
				{ operation: 'upload', objects: [{ oid, size: audio.length }] },
				remote,
			),
		);
		expect(after.objects).toEqual([{ oid, size: audio.length }]);

		const download = await batch(
			await answerBatch(
				store,
				REPO,
				{ operation: 'download', objects: [{ oid, size: audio.length }] },
				remote,
			),
		);
		expect(new URL(actionOf(download, 'download').href).pathname).toBe(
			`/${presigner.bucketName}/lfs/${REPO}/${oid}`,
		);
	});
});
