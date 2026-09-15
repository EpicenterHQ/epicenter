import { expect, test } from 'bun:test';
import { createS3BlobStore } from './s3-blob-store.js';

test('presigned PUT uses unsigned payload with signed create-only headers', async () => {
	const store = createS3BlobStore({
		endpoint: 'https://example.r2.cloudflarestorage.com',
		region: 'auto',
		accessKeyId: 'test-access-key',
		secretAccessKey: 'test-secret-key',
		bucket: 'blobs',
	});

	const signed = await store.presignPut({
		key: 'principals/test/blobs/blob_abcdefghijklmnopqrstu',
		contentType: 'audio/wav',
		expiresInSeconds: 300,
	});
	const url = new URL(signed.url);

	expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe(
		'content-type;host;if-none-match',
	);
	expect(signed.requiredHeaders).toEqual({
		'content-type': 'audio/wav',
		'if-none-match': '*',
	});
	expect(url.searchParams.has('X-Amz-Signature')).toBe(true);
	expect(url.searchParams.has('X-Amz-Content-Sha256')).toBe(false);
});

test('attachment checksum is base64 digest bytes and is signed alongside immutability headers', async () => {
	const store = createS3BlobStore({
		endpoint: 'https://example.r2.cloudflarestorage.com',
		region: 'auto',
		accessKeyId: 'test',
		secretAccessKey: 'test',
		bucket: 'test',
	});
	const sha256 = '0123456789abcdef'.repeat(4);
	const ticket = await store.presignPut({
		key: 'attachment',
		contentType: 'audio/wav',
		sha256,
		expiresInSeconds: 300,
	});
	expect(ticket.requiredHeaders['x-amz-checksum-sha256']).toBe(
		Buffer.from(sha256, 'hex').toString('base64'),
	);
	expect(new URL(ticket.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
		'content-type;host;if-none-match;x-amz-checksum-sha256',
	);
	await expect(
		store.presignPut({
			key: 'attachment',
			contentType: 'audio/wav',
			sha256: 'bad',
			expiresInSeconds: 300,
		}),
	).rejects.toThrow('SHA-256');
});
