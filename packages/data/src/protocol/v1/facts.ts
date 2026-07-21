/**
 * Facts: the current authority state at one scalar address (ADR-0163).
 *
 * The authority stores exactly one current fact per address. A fact carries two
 * independent axes:
 *
 * - address `kind` (row or value) answers what is addressed; and
 * - `presence` (present or absent) answers whether that address currently
 *   exists.
 *
 * The axes stay separate because an empty object is a valid present row and
 * `null` is a valid present value, so absence cannot be inferred from an empty
 * or null payload. Row absence is a terminal tombstone within one authority
 * lifetime; value absence is a reversible unset. Every fact carries the unique
 * increasing authority `sequence` assigned when that current fact last changed.
 */
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';

import {
	isAdmissibleAddress,
	RowAddressSchema,
	ValueAddressSchema,
} from './addresses.js';
import {
	canonicalize,
	isCanonicalJson,
	maxNodesForCanonicalBytes,
	utf8ByteLength,
} from './canonical.js';
import { catchAsInvalid, ScalarProtocolError } from './errors.js';
import {
	isAdmissibleFieldKey,
	isJsonObject,
	isJsonValue,
	JsonObjectSchema,
	JsonValueSchema,
} from './json.js';
import type { ValidatedLimits } from './limits.js';

const CLOSED = { additionalProperties: false } as const;

/** A positive JSON-safe authority sequence. Sequence zero is "learned nothing". */
export const SequenceSchema = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER,
});

const rowPresentFactSchema = Type.Object(
	{
		address: RowAddressSchema,
		sequence: SequenceSchema,
		presence: Type.Literal('present'),
		fields: JsonObjectSchema,
	},
	CLOSED,
);
const rowAbsentFactSchema = Type.Object(
	{
		address: RowAddressSchema,
		sequence: SequenceSchema,
		presence: Type.Literal('absent'),
	},
	CLOSED,
);
const valuePresentFactSchema = Type.Object(
	{
		address: ValueAddressSchema,
		sequence: SequenceSchema,
		presence: Type.Literal('present'),
		content: JsonValueSchema,
	},
	CLOSED,
);
const valueAbsentFactSchema = Type.Object(
	{
		address: ValueAddressSchema,
		sequence: SequenceSchema,
		presence: Type.Literal('absent'),
	},
	CLOSED,
);

export const FactSchema = Type.Union([
	rowPresentFactSchema,
	rowAbsentFactSchema,
	valuePresentFactSchema,
	valueAbsentFactSchema,
]);
export type Fact = Static<typeof FactSchema>;

/** Canonical-encoded byte size of a fact, the unit `maxEncodedFactBytes` bounds. */
export function encodedFactBytes(fact: Fact): number {
	return utf8ByteLength(canonicalize(fact));
}

/** Semantic admission for an already structurally valid fact. */
export function isAdmissibleFact(fact: Fact, limits: ValidatedLimits): boolean {
	if (!isAdmissibleAddress(fact.address, limits)) return false;
	if (fact.presence === 'present') {
		if ('fields' in fact) {
			if (!isJsonObject(fact.fields, limits)) return false;
			if (
				!Object.keys(fact.fields).every((key) =>
					isAdmissibleFieldKey(key, limits.maxFieldKeyBytes),
				)
			) {
				return false;
			}
		} else if (!isJsonValue(fact.content, limits)) {
			return false;
		}
	}
	return encodedFactBytes(fact) <= limits.maxEncodedFactBytes;
}

export function parseFact(
	value: unknown,
	limits: ValidatedLimits,
): Result<Fact, ScalarProtocolError> {
	return catchAsInvalid('fact', () =>
		isCanonicalJson(
			value,
			maxNodesForCanonicalBytes(limits.maxEncodedFactBytes),
		) &&
		Value.Check(FactSchema, value) &&
		isAdmissibleFact(value, limits)
			? Ok(structuredClone(value))
			: ScalarProtocolError.Invalid({ boundary: 'fact' }),
	);
}
