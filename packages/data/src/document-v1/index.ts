import {
	DOCUMENT_FRAME_LIMITS,
	DOCUMENT_SUBPROTOCOL,
	type DocumentMeasure,
} from '@epicenter/sync/document-v3';

import { parseAddress, type RecordAddress } from '../protocol/v1/addresses.js';
import {
	isPlainDataObject,
	isWellFormedString,
	sha256HexBytes,
	utf8ByteLength,
} from '../protocol/v1/canonical.js';
import type { ValidatedLimits } from '../protocol/v1/limits.js';

/** Exact-byte document publication protocol carried beside scalar V1. */
export const DOCUMENT_PUBLICATION_VERSION = DOCUMENT_SUBPROTOCOL;

export type DocumentPublicationRequest = {
	authorityLifetime: string;
	address: RecordAddress;
	protocolVersion: typeof DOCUMENT_PUBLICATION_VERSION;
	payload: Uint8Array;
	digest: string;
};

/** Post-commit proof for one exact frozen document payload. */
export type DocumentPublicationReceipt = Omit<
	DocumentPublicationRequest,
	'payload'
>;

/** Durable diagnostic for a well-formed publication the authority could not admit. */
export type DocumentBoundRefusal = DocumentPublicationReceipt & {
	kind: 'document-bound';
	measured: DocumentMeasure;
	limit: DocumentMeasure;
};

export type DocumentAcceptance =
	| { kind: 'accepted'; receipt: DocumentPublicationReceipt }
	| DocumentBoundRefusal
	| {
			kind: 'record-not-live';
			activeAuthorityLifetime: string;
			address: RecordAddress;
			state: 'absent' | 'tombstone' | 'unset';
	  }
	| {
			kind: 'lifetime-mismatch';
			activeAuthorityLifetime: string;
	  };

/** SHA-256 integrity identity for one frozen publication image. */
export function documentPayloadDigest(payload: Uint8Array): string {
	return sha256HexBytes(payload);
}

/** Admit one detached binary publication at an untrusted process boundary. */
export function parseDocumentPublicationRequest(
	value: unknown,
	limits: ValidatedLimits,
): DocumentPublicationRequest | undefined {
	try {
		return parseDocumentPublicationRequestUnsafe(value, limits);
	} catch {
		return undefined;
	}
}

function parseDocumentPublicationRequestUnsafe(
	value: unknown,
	limits: ValidatedLimits,
): DocumentPublicationRequest | undefined {
	if (
		typeof value !== 'object' ||
		value === null ||
		!isPlainDataObject(value)
	) {
		return undefined;
	}
	const keys = Object.keys(value);
	if (
		keys.length !== 5 ||
		!keys.includes('authorityLifetime') ||
		!keys.includes('address') ||
		!keys.includes('protocolVersion') ||
		!keys.includes('payload') ||
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
		candidate.protocolVersion !== DOCUMENT_PUBLICATION_VERSION ||
		!(candidate.payload instanceof Uint8Array) ||
		candidate.payload.byteLength === 0 ||
		candidate.payload.byteLength > DOCUMENT_FRAME_LIMITS.payloadBytes ||
		typeof candidate.digest !== 'string' ||
		!/^[a-f0-9]{64}$/.test(candidate.digest) ||
		documentPayloadDigest(candidate.payload) !== candidate.digest
	) {
		return undefined;
	}
	const address = parseAddress(candidate.address, limits);
	if (address.error !== null) return undefined;
	return {
		authorityLifetime: candidate.authorityLifetime,
		address: address.data,
		protocolVersion: DOCUMENT_PUBLICATION_VERSION,
		payload: new Uint8Array(candidate.payload),
		digest: candidate.digest,
	};
}
