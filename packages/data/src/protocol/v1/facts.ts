/**
 * Facts: the current authority state at one record address (ADR-0163).
 *
 * The authority stores exactly one current fact per address. There is one fact
 * shape; the stored `state`, not a caller species, carries the meaning of
 * absence:
 *
 * - `live` is presence, with `payload` present exactly then;
 * - `tombstone` is terminal absence within one authority lifetime; and
 * - `unset` is reversible absence.
 *
 * An empty object and `null` are ordinary live payloads, never absence, so
 * absence can never be inferred from a payload. Every fact carries the unique
 * increasing authority `sequence` assigned when that current fact last changed.
 */
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';

import { isAdmissibleAddress, RecordAddressSchema } from './addresses.js';
import {
	canonicalize,
	isCanonicalJson,
	maxNodesForCanonicalBytes,
	utf8ByteLength,
} from './canonical.js';
import { catchAsInvalid, ScalarProtocolError } from './errors.js';
import { isJsonValue, JsonValueSchema } from './json.js';
import type { ValidatedLimits } from './limits.js';

const CLOSED = { additionalProperties: false } as const;

/** A positive JSON-safe authority sequence. Sequence zero is "learned nothing". */
export const SequenceSchema = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER,
});

const liveFactSchema = Type.Object(
	{
		address: RecordAddressSchema,
		sequence: SequenceSchema,
		state: Type.Literal('live'),
		payload: JsonValueSchema,
	},
	CLOSED,
);
const tombstoneFactSchema = Type.Object(
	{
		address: RecordAddressSchema,
		sequence: SequenceSchema,
		state: Type.Literal('tombstone'),
	},
	CLOSED,
);
const unsetFactSchema = Type.Object(
	{
		address: RecordAddressSchema,
		sequence: SequenceSchema,
		state: Type.Literal('unset'),
	},
	CLOSED,
);

export const FactSchema = Type.Union([
	liveFactSchema,
	tombstoneFactSchema,
	unsetFactSchema,
]);
export type Fact = Static<typeof FactSchema>;

/** Canonical-encoded byte size of a fact, the unit `maxEncodedFactBytes` bounds. */
export function encodedFactBytes(fact: Fact): number {
	return utf8ByteLength(canonicalize(fact));
}

/** Semantic admission for an already structurally valid fact. */
export function isAdmissibleFact(fact: Fact, limits: ValidatedLimits): boolean {
	if (!isAdmissibleAddress(fact.address, limits)) return false;
	// `payload` is present exactly when the state is live. The closed schemas
	// already refuse a payload on an absent state; this keeps a live fact from
	// smuggling `undefined` (or an exotic value) through the structural check.
	if (fact.state === 'live') {
		if (!('payload' in fact) || !isJsonValue(fact.payload, limits)) {
			return false;
		}
	} else if ('payload' in fact) {
		return false;
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
