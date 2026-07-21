/**
 * Intents: a replica's desired transition at one scalar address (ADR-0163).
 *
 * Typed application verbs (`create`, `update`, `delete`, value `set`/`unset`)
 * lower into this smaller wire algebra. Row create and update do not exist on
 * the wire: both become one row-present field patch (`set` plus `unset`) that
 * the authority folds over the live row, or over an empty object when the
 * address has no fact. The four intent shapes mirror the four fact shapes on the
 * same address-kind and presence axes.
 */
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';

import {
	isAdmissibleAddress,
	RowAddressSchema,
	ValueAddressSchema,
} from './addresses.js';
import { isCanonicalJson, maxNodesForCanonicalBytes } from './canonical.js';
import { catchAsInvalid, ScalarProtocolError } from './errors.js';
import { encodedFactBytes, type Fact } from './facts.js';
import {
	isAdmissibleFieldKey,
	isJsonObject,
	isJsonValue,
	JsonObjectSchema,
	JsonValueSchema,
} from './json.js';
import type { ValidatedLimits } from './limits.js';

const CLOSED = { additionalProperties: false } as const;
const fieldKeySchema = Type.String({ minLength: 1 });

const rowPresentIntentSchema = Type.Object(
	{
		address: RowAddressSchema,
		presence: Type.Literal('present'),
		set: JsonObjectSchema,
		unset: Type.Array(fieldKeySchema),
	},
	CLOSED,
);
const rowAbsentIntentSchema = Type.Object(
	{
		address: RowAddressSchema,
		presence: Type.Literal('absent'),
	},
	CLOSED,
);
const valuePresentIntentSchema = Type.Object(
	{
		address: ValueAddressSchema,
		presence: Type.Literal('present'),
		content: JsonValueSchema,
	},
	CLOSED,
);
const valueAbsentIntentSchema = Type.Object(
	{
		address: ValueAddressSchema,
		presence: Type.Literal('absent'),
	},
	CLOSED,
);

export const IntentSchema = Type.Union([
	rowPresentIntentSchema,
	rowAbsentIntentSchema,
	valuePresentIntentSchema,
	valueAbsentIntentSchema,
]);
export type Intent = Static<typeof IntentSchema>;

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

	if (intent.presence === 'absent') {
		// A delete or unset must be able to install a maximum-sequence absent
		// fact within the encoded ceiling, so the authority can always store it.
		const address = intent.address;
		const absentFact: Fact =
			address.kind === 'row'
				? { address, sequence: Number.MAX_SAFE_INTEGER, presence: 'absent' }
				: { address, sequence: Number.MAX_SAFE_INTEGER, presence: 'absent' };
		return factFits(absentFact, limits);
	}

	if ('content' in intent) {
		// The optimistic value fact this intent produces must itself fit.
		return (
			isJsonValue(intent.content, limits) &&
			factFits(
				{
					address: intent.address,
					sequence: Number.MAX_SAFE_INTEGER,
					presence: 'present',
					content: intent.content,
				},
				limits,
			)
		);
	}

	// row-present: a field patch with disjoint, bounded, admissible keys.
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
				isAdmissibleFieldKey(key, limits.maxFieldKeyBytes) && !unset.has(key),
		)
	) {
		return false;
	}
	// The optimistic row fact folded over an empty base must fit. Authority
	// parking is then reserved for a patch folded over a different live base.
	return factFits(
		{
			address: intent.address,
			sequence: Number.MAX_SAFE_INTEGER,
			presence: 'present',
			fields: intent.set,
		},
		limits,
	);
}

export function parseIntent(
	value: unknown,
	limits: ValidatedLimits,
): Result<Intent, ScalarProtocolError> {
	return catchAsInvalid('intent', () =>
		isCanonicalJson(
			value,
			// A row-present intent adds the `unset` array and its bounded string
			// children to the tree represented by its bounded optimistic fact.
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
