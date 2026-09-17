/** Backup requests retain signed create-only headers at the S3 boundary. */
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
		key: 'libraries/apps/so.epicenter.notes/personal/test/data/so.epicenter.notes/backups/blob_abcdefghijklmnopqrstu',
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
