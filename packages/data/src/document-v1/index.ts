import {
	DOCUMENT_SUBPROTOCOL,
	type DocumentMeasure,
} from '@epicenter/sync/document-v3';

import type { RecordAddress } from '../protocol/v1/addresses.js';
import { sha256HexBytes } from '../protocol/v1/canonical.js';

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

/** SHA-256 integrity identity for one frozen publication image. */
export function documentPayloadDigest(payload: Uint8Array): string {
	return sha256HexBytes(payload);
}
