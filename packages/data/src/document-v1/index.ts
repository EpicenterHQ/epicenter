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

/**
 * The document plane's HTTP header vocabulary.
 *
 * Both endpoints read these names from here, so a route and a carrier cannot
 * drift apart on a spelling. `ETAG`/`IF_NONE_MATCH` are the ordinary HTTP
 * validators carrying the opaque document version on pull.
 */
export const DOCUMENT_LIFETIME_HEADER = 'x-epicenter-authority-lifetime';
export const DOCUMENT_PROTOCOL_HEADER = 'x-epicenter-document-protocol';
export const DOCUMENT_DIGEST_HEADER = 'x-epicenter-document-digest';

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

/**
 * The one non-2xx status that carries a typed authority outcome.
 *
 * Every semantic refusal (`document-bound`, `record-not-live`,
 * `lifetime-mismatch`) is a conflict with authority state, not a transport
 * fault, so the route answers all three with this status and one encoded
 * acceptance body.
 */
export const DOCUMENT_ACCEPTANCE_CONFLICT_STATUS = 409;

/**
 * The authority's opaque version of one document's committed state.
 *
 * It is the digest of the canonical `encodeStateAsUpdateV2` state the
 * authority would serve, so it is derived rather than stored: nothing has to
 * advance a counter in step with the chain, and a compaction that preserves
 * semantic state preserves the version. Replicas treat it as opaque and only
 * ever compare it for equality.
 */
export function documentVersionOf(state: Uint8Array): string {
	return sha256HexBytes(state);
}

/**
 * The answer to one explicit `pull()` (ADR-0171).
 *
 * `unchanged` and `absent` carry no bytes: the first means the replica already
 * holds the authority's version, the second that a live record has no
 * committed document state at all. Both refusals name the active authority
 * lifetime so the replica can fence installation.
 */
export type DocumentPull =
	| {
			kind: 'state';
			activeAuthorityLifetime: string;
			documentVersion: string;
			update: Uint8Array;
	  }
	| {
			kind: 'unchanged';
			activeAuthorityLifetime: string;
			documentVersion: string;
	  }
	| { kind: 'absent'; activeAuthorityLifetime: string }
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

/** Admit one typed pull refusal decoded at an untrusted process boundary. */
export function parseDocumentPullRefusal(
	value: unknown,
	limits: ValidatedLimits,
):
	| Extract<DocumentPull, { kind: 'record-not-live' | 'lifetime-mismatch' }>
	| undefined {
	const acceptance = parseDocumentAcceptance(value, limits);
	return acceptance?.kind === 'record-not-live' ||
		acceptance?.kind === 'lifetime-mismatch'
		? acceptance
		: undefined;
}

/**
 * Read one publication response from an HTTP carrier.
 *
 * This is the whole status boundary: 200 and 409 carry a decision the replica
 * must act on, and every other status is operational (proxy, auth, or bug).
 * Carriers must not throw before decoding, because discarding a valid 409
 * turns a settled refusal into an unbounded retry.
 */
export async function readDocumentAcceptance(
	response: Response,
	limits: ValidatedLimits,
): Promise<DocumentAcceptance> {
	if (
		response.status !== 200 &&
		response.status !== DOCUMENT_ACCEPTANCE_CONFLICT_STATUS
	) {
		throw new Error(
			`Epicenter document publication failed (${response.status})`,
		);
	}
	const acceptance = parseDocumentAcceptance(await response.json(), limits);
	if (acceptance === undefined) {
		throw new Error('Epicenter document publication response was invalid');
	}
	return acceptance;
}

/** The statuses one pull response may carry, each meaning exactly one thing. */
export const DOCUMENT_PULL_STATUS = {
	/** Committed state follows, tagged with its opaque version. */
	state: 200,
	/** The live record has never committed document state. */
	absent: 204,
	/** The replica's known version is still the authority's version. */
	unchanged: 304,
	/** A typed refusal body follows. */
	refused: DOCUMENT_ACCEPTANCE_CONFLICT_STATUS,
} as const;

/**
 * Read one pull response from an HTTP carrier.
 *
 * Like publication, a refusal is a conflict with authority state rather than a
 * transport fault, so it decodes instead of throwing. Every other status is
 * operational and stays retryable.
 */
export async function readDocumentPull(
	response: Response,
	limits: ValidatedLimits,
): Promise<DocumentPull> {
	const activeAuthorityLifetime = parseAuthorityLifetime(
		response.headers.get(DOCUMENT_LIFETIME_HEADER),
		limits,
	);
	if (response.status === DOCUMENT_PULL_STATUS.refused) {
		const refusal = parseDocumentPullRefusal(await response.json(), limits);
		if (refusal === undefined) {
			throw new Error('Epicenter document pull response was invalid');
		}
		return refusal;
	}
	if (activeAuthorityLifetime === undefined) {
		throw new Error('Epicenter document pull response named no authority');
	}
	switch (response.status) {
		case DOCUMENT_PULL_STATUS.absent:
			return { kind: 'absent', activeAuthorityLifetime };
		case DOCUMENT_PULL_STATUS.unchanged: {
			const documentVersion = parseDocumentVersion(
				response.headers.get('etag'),
			);
			if (documentVersion === undefined) {
				throw new Error('Epicenter document pull named no version');
			}
			return { kind: 'unchanged', activeAuthorityLifetime, documentVersion };
		}
		case DOCUMENT_PULL_STATUS.state: {
			const documentVersion = parseDocumentVersion(
				response.headers.get('etag'),
			);
			const update = new Uint8Array(await response.arrayBuffer());
			if (
				documentVersion === undefined ||
				update.byteLength === 0 ||
				update.byteLength > DOCUMENT_FRAME_LIMITS.payloadBytes ||
				documentVersionOf(update) !== documentVersion
			) {
				throw new Error('Epicenter document pull response was invalid');
			}
			return {
				kind: 'state',
				activeAuthorityLifetime,
				documentVersion,
				update,
			};
		}
		default:
			throw new Error(`Epicenter document pull failed (${response.status})`);
	}
}

/** Read one strong ETag back into the opaque version it carries. */
function parseDocumentVersion(value: string | null): string | undefined {
	const inner = value?.match(/^"([a-f0-9]{64})"$/)?.[1];
	return inner ?? undefined;
}

/** Render one opaque document version as a strong HTTP validator. */
export function documentVersionTag(documentVersion: string): string {
	return `"${documentVersion}"`;
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
