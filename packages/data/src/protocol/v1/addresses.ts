/**
 * Structured scalar addresses (ADR-0160, ADR-0163).
 *
 * A scalar address is the unit of independent convergence. It is a structured
 * object, never a flat qualified string: `kind` answers what is addressed, and
 * the remaining coordinates locate it inside a durable namespace. Row and value
 * addresses share a namespace but not a key space, so one namespace may reuse a
 * name for a table and a value without collision.
 *
 * The 24-character lowercase runtime-id shape is a permanent invariant (spec).
 * The namespace and local-key grammars below are V1-local choices, not yet
 * frozen by an ADR; they may tighten or widen before V1 is accepted. Byte-length
 * ceilings stay parametric (see `ScalarSyncLimits`). All patterns are ASCII, so
 * a lone UTF-16 surrogate can never appear in an address coordinate.
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
/** V1-local short local table or value key: an identifier starting with a letter. */
const LOCAL_KEY_PATTERN = '^[A-Za-z][A-Za-z0-9_]*$';
/** Runtime-minted 24-character lowercase alphanumeric row id; frozen by spec. */
const RUNTIME_ID_PATTERN = '^[a-z0-9]{24}$';

const namespaceSchema = Type.String({
	minLength: 1,
	pattern: NAMESPACE_PATTERN,
});
const localKeySchema = Type.String({
	minLength: 1,
	pattern: LOCAL_KEY_PATTERN,
});
const rowIdSchema = Type.String({
	minLength: 24,
	maxLength: 24,
	pattern: RUNTIME_ID_PATTERN,
});

export const RowAddressSchema = Type.Object(
	{
		kind: Type.Literal('row'),
		namespace: namespaceSchema,
		table: localKeySchema,
		rowId: rowIdSchema,
	},
	CLOSED,
);
export type RowAddress = Static<typeof RowAddressSchema>;

export const ValueAddressSchema = Type.Object(
	{
		kind: Type.Literal('value'),
		namespace: namespaceSchema,
		value: localKeySchema,
	},
	CLOSED,
);
export type ValueAddress = Static<typeof ValueAddressSchema>;

export const AddressSchema = Type.Union([RowAddressSchema, ValueAddressSchema]);
export type Address = Static<typeof AddressSchema>;

/**
 * A private, order-stable identity string for a structured address.
 *
 * This is internal map-keying only; it never appears on the wire. The canonical
 * form makes the identity independent of coordinate insertion order and keeps
 * row and value addresses in disjoint key spaces via the `kind` discriminant.
 */
export function addressKey(address: Address): string {
	return canonicalize(address);
}

/** Pure structured-identity equality: equal exactly when every coordinate matches. */
export function addressesEqual(left: Address, right: Address): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === 'row') {
		return (
			right.kind === 'row' &&
			left.namespace === right.namespace &&
			left.table === right.table &&
			left.rowId === right.rowId
		);
	}
	return (
		right.kind === 'value' &&
		left.namespace === right.namespace &&
		left.value === right.value
	);
}

/** Semantic byte-length admission for an already structurally valid address. */
export function isAdmissibleAddress(
	address: Address,
	limits: ValidatedLimits,
): boolean {
	if (utf8ByteLength(address.namespace) > limits.maxNamespaceBytes)
		return false;
	return address.kind === 'row'
		? utf8ByteLength(address.table) <= limits.maxTableKeyBytes
		: utf8ByteLength(address.value) <= limits.maxValueKeyBytes;
}

export function parseAddress(
	value: unknown,
	limits: ValidatedLimits,
): Result<Address, ScalarProtocolError> {
	return catchAsInvalid('address', () =>
		// One object plus the maximum four leaf coordinates of a row address.
		isCanonicalJson(value, 5) &&
		Value.Check(AddressSchema, value) &&
		isAdmissibleAddress(value, limits)
			? Ok(structuredClone(value))
			: ScalarProtocolError.Invalid({ boundary: 'address' }),
	);
}
