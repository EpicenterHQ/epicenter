import { createS3BlobStore, type S3BlobStore, type S3BlobStoreConfig } from '../s3-blob-store.js';

function resolveBlobStoreConfig(env: {
	BLOBS_S3_ENDPOINT?: string;
	BLOBS_S3_ACCESS_KEY_ID?: string;
	BLOBS_S3_SECRET_ACCESS_KEY?: string;
	BLOBS_S3_BUCKET?: string;
	BLOBS_S3_REGION?: string;
}): S3BlobStoreConfig | null {
	if (
		!env.BLOBS_S3_ENDPOINT ||
		!env.BLOBS_S3_ACCESS_KEY_ID ||
		!env.BLOBS_S3_SECRET_ACCESS_KEY
	) return null;
	return {
		endpoint: env.BLOBS_S3_ENDPOINT.replace(/\/+$/, ''),
		region: env.BLOBS_S3_REGION ?? 'auto',
		accessKeyId: env.BLOBS_S3_ACCESS_KEY_ID,
		secretAccessKey: env.BLOBS_S3_SECRET_ACCESS_KEY,
		bucket: env.BLOBS_S3_BUCKET ?? 'epicenter-blobs',
	};
}

/** Deployment object storage; routes return 503 when it is unconfigured. */
export function resolveDeploymentBlobStore(
	env: Parameters<typeof resolveBlobStoreConfig>[0],
): S3BlobStore | null {
	const config = resolveBlobStoreConfig(env);
	return config === null ? null : createS3BlobStore(config);
}
