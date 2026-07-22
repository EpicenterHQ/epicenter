/**
 * The four record operations and the intent that carries one (ADR-0163).
 *
 * Typed application verbs (table `create`/`update`/`delete`, value
 * `set`/`unset`) lower into a smaller synchronization algebra of four
 * discriminated operations at one record address:
 *
 * - `patch` makes or keeps the record present by folding top-level fields
 *   (`set` plus `unset`) over the live payload, or over an empty object when
 *   the address has no live fact. Table create and update do not exist on the
 *   wire: both are this one patch.
 * - `replace` makes or keeps the record present by whole replacement.
 * - `tombstone` installs terminal absence within this authority lifetime.
 * - `unset` installs reversible absence.
 *
 * An intent is one operation at one address. One composition law (see
 * `fold.ts`) governs pending compaction, parked compaction at settlement, and
 * the authority fold alike, with tombstone absorption evaluated first.
 */
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';

import {
	isAdmissibleAddress,
	type RecordAddress,
	RecordAddressSchema,
} from './addresses.js';
import { isCanonicalJson, maxNodesForCanonicalBytes } from './canonical.js';
import { catchAsInvalid, ScalarProtocolError } from './errors.js';
import { encodedFactBytes, type Fact } from './facts.js';
import {
	isAdmissibleFieldKey,
	isJsonObject,
	isJsonValue,
	type JsonObject,
	JsonObjectSchema,
	type JsonValue,
	JsonValueSchema,
} from './json.js';
import type { ValidatedLimits } from './limits.js';

const CLOSED = { additionalProperties: false } as const;
const fieldKeySchema = Type.String({ minLength: 1 });

const patchIntentSchema = Type.Object(
	{
		address: RecordAddressSchema,
		op: Type.Literal('patch'),
		set: JsonObjectSchema,
		unset: Type.Array(fieldKeySchema),
	},
	CLOSED,
);
const replaceIntentSchema = Type.Object(
	{
		address: RecordAddressSchema,
		op: Type.Literal('replace'),
		value: JsonValueSchema,
	},
	CLOSED,
);
const tombstoneIntentSchema = Type.Object(
	{
		address: RecordAddressSchema,
		op: Type.Literal('tombstone'),
	},
	CLOSED,
);
const unsetIntentSchema = Type.Object(
	{
		address: RecordAddressSchema,
		op: Type.Literal('unset'),
	},
	CLOSED,
);

/** One record operation without its address: an intent minus `address`. */
export type Operation =
	| { op: 'patch'; set: JsonObject; unset: string[] }
	| { op: 'replace'; value: JsonValue }
	| { op: 'tombstone' }
	| { op: 'unset' };

/** One desired operation at one record address. */
export type Intent = { address: RecordAddress } & Operation;

export const IntentSchema = Type.Unsafe<Intent>(
	Type.Union([
		patchIntentSchema,
		replaceIntentSchema,
		tombstoneIntentSchema,
		unsetIntentSchema,
	]),
);

/** Whether a candidate fact at its maximum sequence fits the encoded ceiling. */
function factFits(fact: Fact, limits: ValidatedLimits): boolean {
	return encodedFactBytes(fact) <= limits.maxEncodedFactBytes;
}

/** Semantic admission for an already structurally valid intent. */
export function isAdmissibleIntent(
	intent: Intent,
	limits: ValidatedLimits,
): boolean {
	if (!isAdmissibleAddress(intent.address, limits)) return false;

	switch (intent.op) {
		case 'tombstone':
		case 'unset': {
			// An absence operation must be able to install a maximum-sequence absent
			// fact within the encoded ceiling, so the authority can always store it.
			return factFits(
				{
					address: intent.address,
					sequence: Number.MAX_SAFE_INTEGER,
					state: intent.op,
				},
				limits,
			);
		}
		case 'replace': {
			// The live fact this operation produces must itself fit.
			return (
				isJsonValue(intent.value, limits) &&
				factFits(
					{
						address: intent.address,
						sequence: Number.MAX_SAFE_INTEGER,
						state: 'live',
						payload: intent.value,
					},
					limits,
				)
			);
		}
		case 'patch': {
			// A field patch with disjoint, bounded, admissible keys.
			if (!isJsonObject(intent.set, limits)) return false;
			if (intent.unset.length > limits.maxUnsetKeysPerIntent) return false;
			const unset = new Set(intent.unset);
			if (unset.size !== intent.unset.length) return false;
			if (
				!intent.unset.every((key) =>
					isAdmissibleFieldKey(key, limits.maxFieldKeyBytes),
				)
			)
				return false;
			if (
				!Object.keys(intent.set).every(
					(key) =>
						isAdmissibleFieldKey(key, limits.maxFieldKeyBytes) &&
						!unset.has(key),
				)
			) {
				return false;
			}
			// The optimistic live fact folded over an empty base must fit. Authority
			// parking is then reserved for a patch folded over a different live base.
			return factFits(
				{
					address: intent.address,
					sequence: Number.MAX_SAFE_INTEGER,
					state: 'live',
					payload: intent.set,
				},
				limits,
			);
		}
	}
}

export function parseIntent(
	value: unknown,
	limits: ValidatedLimits,
): Result<Intent, ScalarProtocolError> {
	return catchAsInvalid('intent', () =>
		isCanonicalJson(
			value,
			// A patch intent adds the `unset` array and its bounded string children
			// to the tree represented by its bounded optimistic fact.
			Math.min(
				Number.MAX_SAFE_INTEGER,
				maxNodesForCanonicalBytes(limits.maxEncodedFactBytes) +
					1 +
					limits.maxUnsetKeysPerIntent,
			),
		) &&
		Value.Check(IntentSchema, value) &&
		isAdmissibleIntent(value, limits)
			? Ok(structuredClone(value))
			: ScalarProtocolError.Invalid({ boundary: 'intent' }),
	);
}
