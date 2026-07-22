/**
 * The record address (ADR-0160, ADR-0163).
 *
 * The durable platform noun is the record: one structured address
 * `(namespace, collection, recordKey)` naming the unit of independent
 * convergence. There is no durable or wire address kind; how applications
 * interpret a collection's records (rows versus values) is Lens vocabulary
 * that never reaches the protocol.
 *
 * The 24-character lowercase runtime-mint grammar for table record keys is a
 * permanent invariant (spec). Because the wire carries no collection kind, the
 * record-key admission grammar is the union of that mint and the Lens
 * local-key grammar that values collections declare. The namespace and
 * local-key grammars are V1-local choices, not yet frozen by an ADR; they may
 * tighten or widen before V1 is accepted. Byte-length ceilings stay parametric
 * (see `ScalarSyncLimits`). All patterns are ASCII, so a lone UTF-16 surrogate
 * can never appear in an address coordinate and canonical address ordering is
 * unambiguous unsigned bytewise UTF-8 comparison.
 */
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';

import { canonicalize, isCanonicalJson, utf8ByteLength } from './canonical.js';
import { catchAsInvalid, ScalarProtocolError } from './errors.js';
import type { ValidatedLimits } from './limits.js';

const CLOSED = { additionalProperties: false } as const;

/** V1-local reverse-domain namespace: two or more lowercase, dot-separated labels. */
const NAMESPACE_PATTERN =
	'^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$';
/** V1-local Lens local key: an identifier starting with a letter. */
const LOCAL_KEY_PATTERN = '^[A-Za-z][A-Za-z0-9_]*$';
/** Runtime-minted 24-character lowercase alphanumeric record key; frozen by spec. */
const RUNTIME_MINT_PATTERN = '^[a-z0-9]{24}$';
/** A record key is either a runtime mint or a Lens-declared local key. */
const RECORD_KEY_PATTERN = `(?:${RUNTIME_MINT_PATTERN})|(?:${LOCAL_KEY_PATTERN})`;

const namespaceSchema = Type.String({
	minLength: 1,
	pattern: NAMESPACE_PATTERN,
});
const collectionSchema = Type.String({
	minLength: 1,
	pattern: LOCAL_KEY_PATTERN,
});
const recordKeySchema = Type.String({
	minLength: 1,
	pattern: RECORD_KEY_PATTERN,
});

export const RecordAddressSchema = Type.Object(
	{
		namespace: namespaceSchema,
		collection: collectionSchema,
		recordKey: recordKeySchema,
	},
	CLOSED,
);
export type RecordAddress = Static<typeof RecordAddressSchema>;

/**
 * A private, order-stable identity string for a structured address.
 *
 * This is internal map-keying only; it never appears on the wire. The canonical
 * form makes the identity independent of coordinate insertion order.
 */
export function addressKey(address: RecordAddress): string {
	return canonicalize(address);
}

/** Pure structured-identity equality: equal exactly when every coordinate matches. */
export function addressesEqual(
	left: RecordAddress,
	right: RecordAddress,
): boolean {
	return (
		left.namespace === right.namespace &&
		left.collection === right.collection &&
		left.recordKey === right.recordKey
	);
}

/** Semantic byte-length admission for an already structurally valid address. */
export function isAdmissibleAddress(
	address: RecordAddress,
	limits: ValidatedLimits,
): boolean {
	return (
		utf8ByteLength(address.namespace) <= limits.maxNamespaceBytes &&
		utf8ByteLength(address.collection) <= limits.maxCollectionKeyBytes &&
		utf8ByteLength(address.recordKey) <= limits.maxRecordKeyBytes
	);
}

export function parseAddress(
	value: unknown,
	limits: ValidatedLimits,
): Result<RecordAddress, ScalarProtocolError> {
	return catchAsInvalid('address', () =>
		// One object plus its three leaf coordinates.
		isCanonicalJson(value, 4) &&
		Value.Check(RecordAddressSchema, value) &&
		isAdmissibleAddress(value, limits)
			? Ok(structuredClone(value))
			: ScalarProtocolError.Invalid({ boundary: 'address' }),
	);
}
