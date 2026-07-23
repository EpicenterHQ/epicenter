import {
	DOCUMENT_BOUND,
	DOCUMENT_FRAME_LIMITS,
	DOCUMENT_SUBPROTOCOL,
	type DocumentMeasure,
	exceedsDocumentBound,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';

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

/** Post-commit proof for one exact frozen document payload. */
export type DocumentPublicationReceipt = {
	authorityLifetime: string;
	address: RecordAddress;
	protocolVersion: typeof DOCUMENT_PUBLICATION_VERSION;
	digest: string;
};

export type DocumentPublicationRequest = DocumentPublicationReceipt & {
	payload: Uint8Array;
};

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

const acceptanceEncoder = new TextEncoder();
const acceptanceDecoder = new TextDecoder('utf-8', { fatal: true });

function hasExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const keys = Object.keys(value);
	return (
		keys.length === expected.length &&
		expected.every((key) => Object.hasOwn(value, key))
	);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' && value !== null && isPlainDataObject(value)
	);
}

function parseAuthorityLifetime(
	value: unknown,
	limits: ValidatedLimits,
): string | undefined {
	return typeof value === 'string' &&
		value.length > 0 &&
		isWellFormedString(value) &&
		utf8ByteLength(value) <= limits.maxLifetimeBytes
		? value
		: undefined;
}

function parseReceiptFields(
	value: Record<string, unknown>,
	limits: ValidatedLimits,
): DocumentPublicationReceipt | undefined {
	const authorityLifetime = parseAuthorityLifetime(
		value.authorityLifetime,
		limits,
	);
	const address = parseAddress(value.address, limits);
	if (
		authorityLifetime === undefined ||
		address.error !== null ||
		value.protocolVersion !== DOCUMENT_PUBLICATION_VERSION ||
		typeof value.digest !== 'string' ||
		!/^[a-f0-9]{64}$/.test(value.digest)
	) {
		return undefined;
	}
	return {
		authorityLifetime,
		address: address.data,
		protocolVersion: DOCUMENT_PUBLICATION_VERSION,
		digest: value.digest,
	};
}

function parseMeasure(value: unknown): DocumentMeasure | undefined {
	if (!isPlainRecord(value)) return undefined;
	const { stateBytes, stateStructs } = value;
	if (
		!hasExactKeys(value, ['stateBytes', 'stateStructs']) ||
		typeof stateBytes !== 'number' ||
		!Number.isSafeInteger(stateBytes) ||
		stateBytes < 0 ||
		typeof stateStructs !== 'number' ||
		!Number.isSafeInteger(stateStructs) ||
		stateStructs < 0
	) {
		return undefined;
	}
	return { stateBytes, stateStructs };
}

/** Admit one post-commit result decoded from either document carrier. */
export function parseDocumentAcceptance(
	value: unknown,
	limits: ValidatedLimits,
): DocumentAcceptance | undefined {
	try {
		if (!isPlainRecord(value) || typeof value.kind !== 'string') {
			return undefined;
		}
		switch (value.kind) {
			case 'accepted': {
				if (
					!hasExactKeys(value, ['kind', 'receipt']) ||
					!isPlainRecord(value.receipt) ||
					!hasExactKeys(value.receipt, [
						'authorityLifetime',
						'address',
						'protocolVersion',
						'digest',
					])
				) {
					return undefined;
				}
				const receipt = parseReceiptFields(value.receipt, limits);
				return receipt === undefined
					? undefined
					: { kind: 'accepted', receipt };
			}
			case 'document-bound': {
				if (
					!hasExactKeys(value, [
						'authorityLifetime',
						'address',
						'protocolVersion',
						'digest',
						'kind',
						'measured',
						'limit',
					])
				) {
					return undefined;
				}
				const receipt = parseReceiptFields(value, limits);
				const measured = parseMeasure(value.measured);
				const limit = parseMeasure(value.limit);
				if (
					receipt === undefined ||
					measured === undefined ||
					!exceedsDocumentBound(measured) ||
					limit?.stateBytes !== DOCUMENT_BOUND.stateBytes ||
					limit.stateStructs !== DOCUMENT_BOUND.stateStructs
				) {
					return undefined;
				}
				return { ...receipt, kind: 'document-bound', measured, limit };
			}
			case 'record-not-live': {
				if (
					!hasExactKeys(value, [
						'kind',
						'activeAuthorityLifetime',
						'address',
						'state',
					])
				) {
					return undefined;
				}
				const activeAuthorityLifetime = parseAuthorityLifetime(
					value.activeAuthorityLifetime,
					limits,
				);
				const address = parseAddress(value.address, limits);
				if (
					activeAuthorityLifetime === undefined ||
					address.error !== null ||
					(value.state !== 'absent' &&
						value.state !== 'tombstone' &&
						value.state !== 'unset')
				) {
					return undefined;
				}
				return {
					kind: 'record-not-live',
					activeAuthorityLifetime,
					address: address.data,
					state: value.state,
				};
			}
			case 'lifetime-mismatch': {
				if (!hasExactKeys(value, ['kind', 'activeAuthorityLifetime'])) {
					return undefined;
				}
				const activeAuthorityLifetime = parseAuthorityLifetime(
					value.activeAuthorityLifetime,
					limits,
				);
				return activeAuthorityLifetime === undefined
					? undefined
					: { kind: 'lifetime-mismatch', activeAuthorityLifetime };
			}
			default:
				return undefined;
		}
	} catch {
		return undefined;
	}
}

/** Encode the one semantic acceptance shape for HTTP or WebSocket carriage. */
export function encodeDocumentAcceptance(
	acceptance: DocumentAcceptance,
): Uint8Array<ArrayBuffer> {
	return acceptanceEncoder.encode(JSON.stringify(acceptance));
}

/** Decode and admit one bounded WebSocket acceptance payload. */
export function decodeDocumentAcceptance(
	encoded: Uint8Array,
	limits: ValidatedLimits,
): DocumentAcceptance | undefined {
	try {
		if (
			!(encoded instanceof Uint8Array) ||
			encoded.byteLength === 0 ||
			encoded.byteLength > DOCUMENT_FRAME_LIMITS.payloadBytes
		) {
			return undefined;
		}
		return parseDocumentAcceptance(
			JSON.parse(acceptanceDecoder.decode(encoded)),
			limits,
		);
	} catch {
		return undefined;
	}
}

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
	if (!isPlainRecord(value)) {
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
	const candidate = value;
	const authorityLifetime = parseAuthorityLifetime(
		candidate.authorityLifetime,
		limits,
	);
	if (
		authorityLifetime === undefined ||
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
	Y.decodeUpdateV2(candidate.payload);
	const address = parseAddress(candidate.address, limits);
	if (address.error !== null) return undefined;
	return {
		authorityLifetime,
		address: address.data,
		protocolVersion: DOCUMENT_PUBLICATION_VERSION,
		payload: new Uint8Array(candidate.payload),
		digest: candidate.digest,
	};
}
