import { parseAddress, type RecordAddress } from '../protocol/v1/addresses.js';
import {
	canonicalize,
	isPlainDataObject,
	isWellFormedString,
	sha256Hex,
	utf8ByteLength,
} from '../protocol/v1/canonical.js';
import type { ValidatedLimits } from '../protocol/v1/limits.js';

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
	| { kind: 'accepted'; receipt: BlobPublicationReceipt }
	| {
			kind: 'lifetime-mismatch';
			activeAuthorityLifetime: string;
	  }
	| {
			kind: 'record-not-live';
			activeAuthorityLifetime: string;
			address: RecordAddress;
			state: 'absent' | 'unset' | 'tombstone';
	  }
	| {
			kind: 'blob-conflict';
			receipt: BlobPublicationReceipt;
			acceptedDigest: string;
	  };

export type StagedBlob = {
	id: string;
	digest: string;
};

export type OwnedBlobFile = {
	/** Private digest of the complete record address, never an application ID. */
	ownerKey: string;
	digest: string;
};

/**
 * Marks a refusal produced while reading caller-owned blob source bytes.
 *
 * File adapters throw this only around their source reader. Filesystem,
 * integrity, and programming failures remain ordinary exceptions.
 */
export class BlobSourceReadFailure extends Error {
	override readonly name = 'BlobSourceReadFailure';

	constructor(readonly sourceCause: unknown) {
		super('Blob source could not be read');
	}
}

/** Runtime-specific raw-file operations. SQLite remains the membership owner. */
export type BlobFileStore<TSource, TRead> = {
	stage(source: TSource): Promise<StagedBlob>;
	promote(staged: StagedBlob, owner: OwnedBlobFile): Promise<void>;
	open(owner: OwnedBlobFile): Promise<TRead>;
	sweepStaging(): Promise<void>;
	sweepContent(owned: readonly OwnedBlobFile[]): Promise<void>;
};

/** SHA-256 digests carried by the blob protocol are lowercase hexadecimal. */
export function isBlobDigest(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length === 64 &&
		!/[^a-f0-9]/u.test(value)
	);
}

/** Private physical identity for one record-owned digest file. */
export function blobFileOwner(
	address: RecordAddress,
	digest: string,
): OwnedBlobFile {
	if (!isBlobDigest(digest)) throw new TypeError('invalid blob digest');
	return {
		ownerKey: sha256Hex(canonicalize(address)),
		digest,
	};
}

/** Admit blob publication metadata before a runtime consumes its byte stream. */
export function parseBlobPublicationRequest(
	value: unknown,
	limits: ValidatedLimits,
): BlobPublicationRequest | undefined {
	try {
		if (
			typeof value !== 'object' ||
			value === null ||
			!isPlainDataObject(value)
		) {
			return undefined;
		}
		const keys = Object.keys(value);
		if (
			keys.length !== 4 ||
			!keys.includes('authorityLifetime') ||
			!keys.includes('address') ||
			!keys.includes('protocolVersion') ||
			!keys.includes('digest')
		) {
			return undefined;
		}
		const candidate = value as Record<string, unknown>;
		if (
			typeof candidate.authorityLifetime !== 'string' ||
			candidate.authorityLifetime.length === 0 ||
			!isWellFormedString(candidate.authorityLifetime) ||
			utf8ByteLength(candidate.authorityLifetime) > limits.maxLifetimeBytes ||
			candidate.protocolVersion !== BLOB_PUBLICATION_VERSION ||
			!isBlobDigest(candidate.digest)
		) {
			return undefined;
		}
		const address = parseAddress(candidate.address, limits);
		if (address.error !== null) return undefined;
		return {
			authorityLifetime: candidate.authorityLifetime,
			address: address.data,
			protocolVersion: BLOB_PUBLICATION_VERSION,
			digest: candidate.digest,
		};
	} catch {
		return undefined;
	}
}
