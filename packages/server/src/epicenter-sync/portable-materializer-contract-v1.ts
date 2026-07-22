export const PORTABLE_MATERIALIZER_PATHS = {
	export: '/export',
	import: '/import',
	records: '/records',
	importBegin: '/import/begin',
	importRecords: '/import/records',
	importBlobs: '/import/blobs',
	importSeal: '/import/seal',
} as const;

export const PORTABLE_MATERIALIZER_ADDRESS_HEADERS = {
	namespace: 'x-epicenter-record-namespace',
	collection: 'x-epicenter-record-collection',
	recordKey: 'x-epicenter-record-key',
} as const;

/** Cloudflare's basic Container leaves headroom for the index and scratch manifest. */
export const PORTABLE_SQLITE_INDEX_MAX_BYTES = 1024 * 1024 * 1024;

export function portableMaterializerJobName(
	ownerStorageKey: string,
	jobId: string,
): string {
	if (ownerStorageKey.length === 0 || jobId.length === 0) {
		throw new TypeError('portable materializer job identity must not be empty');
	}
	return `${encodeURIComponent(ownerStorageKey)}:${encodeURIComponent(jobId)}`;
}
