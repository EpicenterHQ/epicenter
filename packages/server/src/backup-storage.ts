/** Recovery objects live outside the generic attachment upload/delete namespace. */
import {
	type BlobId,
	type BlobStore,
	BlobStoreError,
	parseBlobId,
} from '@epicenter/blobs';
import { Ok, tryAsync } from 'wellcrafted/result';
import type { S3BlobStore } from './s3-blob-store.js';

/**
 * Bind the server-resolved stable authority name, never a request-supplied key.
 * The returned capability has no delete operation. Account deletion and provider
 * retention are separate policies; this does not promise storage against either.
 */
export function createS3ArchiveStore({
	store,
	library,
}: {
	store: S3BlobStore;
	library: string;
}): Pick<BlobStore, 'put' | 'get'> {
	function key(id: BlobId) {
		if (!parseBlobId(id)) throw new Error('Invalid backup object id');
		return `${library}/backups/${id}`;
	}
	return {
		async put(id, blob) {
			const sent = await tryAsync({
				try: async () => {
					const ticket = await store.presignPut({
						key: key(id),
						contentType: blob.type,
						expiresInSeconds: 60,
					});
					const response = await fetch(ticket.url, {
						method: 'PUT',
						headers: ticket.requiredHeaders,
						body: blob,
					});
					if (response.status === 412) return 'exists' as const;
					if (!response.ok)
						throw new Error(`Archive PUT failed: ${response.status}`);
					return 'created' as const;
				},
				catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
			});
			if (sent.error !== null) return sent;
			return sent.data === 'exists'
				? BlobStoreError.BlobAlreadyExists({ id })
				: Ok(undefined);
		},
		async get(id) {
			const read = await tryAsync({
				try: async () => {
					const url = await store.presignGet({
						key: key(id),
						expiresInSeconds: 60,
					});
					const response = await fetch(url);
					if (response.status === 404) return undefined;
					if (!response.ok)
						throw new Error(`Archive GET failed: ${response.status}`);
					return await response.blob();
				},
				catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
			});
			if (read.error !== null) return read;
			return read.data === undefined
				? BlobStoreError.BlobNotFound({ id })
				: Ok(read.data);
		},
	};
}
