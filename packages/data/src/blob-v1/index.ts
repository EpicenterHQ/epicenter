import type { RecordAddress } from '../protocol/v1/index.js';

/** Private wire version for one record-owned immutable blob publication. */
export const BLOB_PUBLICATION_VERSION = 'epicenter-blob-v1' as const;

export type BlobPublicationRequest = {
	authorityLifetime: string;
	address: RecordAddress;
	protocolVersion: typeof BLOB_PUBLICATION_VERSION;
	digest: string;
};

export type BlobPublicationReceipt = BlobPublicationRequest;

export type BlobAcceptance =
	| ({ kind: 'accepted' } & BlobPublicationReceipt)
	| {
			kind: 'lifetime-mismatch';
			activeAuthorityLifetime: string;
	  }
	| ({
			kind: 'record-not-live';
			state: 'absent' | 'unset' | 'tombstone';
	  } & BlobPublicationReceipt)
	| ({
			kind: 'blob-conflict';
			acceptedDigest: string;
	  } & BlobPublicationReceipt);

/** SHA-256 digests carried by the blob protocol are lowercase hexadecimal. */
export function isBlobDigest(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length === 64 &&
		!/[^a-f0-9]/u.test(value)
	);
}
