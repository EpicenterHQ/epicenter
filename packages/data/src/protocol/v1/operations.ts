/**
 * The two scalar V1 wire operations (ADR-0163).
 *
 *     GET  /api/sync/v1/facts       reads current authority facts
 *     POST /api/sync/v1/submissions submits numbered desired-state intents
 *
 * They are separate operations because learning facts and submitting intents
 * have different identities and retry cadences. Fact learning advances one
 * `afterSequence` watermark; submission carries one replica's ordered numbered
 * stream. There is no combined exchange, cursor, receipt, or public digest.
 *
 * A submission response returns the current fact for every distinct touched
 * address, in sealed intent order. Those facts are the settlement proof; the
 * only address-scoped refusal is a row patch whose folded fact exceeds the
 * encoded-fact ceiling, reported as a bounded `fact-too-large` parked result.
 */
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { Ok, type Result } from 'wellcrafted/result';

import {
	type Address,
	addressesEqual,
	addressKey,
	isAdmissibleAddress,
	RowAddressSchema,
} from './addresses.js';
import {
	canonicalize,
	deepFreeze,
	isCanonicalJson,
	isWellFormedString,
	maxNodesForCanonicalBytes,
	utf8ByteLength,
} from './canonical.js';
import { catchAsInvalid, ScalarProtocolError } from './errors.js';
import { FactSchema, isAdmissibleFact } from './facts.js';
import { IntentSchema, isAdmissibleIntent } from './intents.js';
import type { ValidatedLimits } from './limits.js';

const CLOSED = { additionalProperties: false } as const;

const AfterSequenceSchema = Type.Integer({
	minimum: 0,
	maximum: Number.MAX_SAFE_INTEGER,
});
const SubmissionNumberSchema = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER,
});
const LifetimeSchema = Type.String({ minLength: 1 });
// V1-local replica-id grammar. Unlike the 24-char row id (frozen by spec), the
// replica-id shape is not yet frozen by an ADR and may change before V1.
const ReplicaIdSchema = Type.String({
	minLength: 24,
	maxLength: 24,
	pattern: '^[a-z0-9]{24}$',
});
const NonNegativeIntegerSchema = Type.Integer({
	minimum: 0,
	maximum: Number.MAX_SAFE_INTEGER,
});

// ---------------------------------------------------------------------------
// Facts operation
// ---------------------------------------------------------------------------

export const FactsRequestSchema = Type.Object(
	{
		authorityLifetime: Type.Optional(LifetimeSchema),
		afterSequence: AfterSequenceSchema,
	},
	CLOSED,
);
export type FactsRequest = Static<typeof FactsRequestSchema>;

declare const admittedFacts: unique symbol;
/**
 * A facts request proven admissible: the lifetime cross-field rule holds and
 * the lifetime is a well-formed, bounded string. Only `parseFactsRequest` mints
 * it, so `readFacts` cannot be called on unadmitted input.
 */
export type AdmittedFactsRequest = FactsRequest & {
	readonly [admittedFacts]: true;
};

export const FactsResponseSchema = Type.Object(
	{
		authorityLifetime: LifetimeSchema,
		facts: Type.Array(FactSchema),
		hasMore: Type.Boolean(),
	},
	CLOSED,
);
export type FactsResponse = Static<typeof FactsResponseSchema>;

function isBoundedLifetime(lifetime: string, limits: ValidatedLimits): boolean {
	return (
		isWellFormedString(lifetime) &&
		utf8ByteLength(lifetime) <= limits.maxLifetimeBytes
	);
}

/**
 * A detached, deep-frozen copy of an admitted request. Sealing at admission
 * means a caller cannot mutate a request after parsing (for example push a
 * duplicate intent) and then submit it, so the authority never folds unadmitted
 * input.
 */
function seal<T>(value: T): T {
	return deepFreeze(structuredClone(value));
}

export function parseFactsRequest(
	value: unknown,
	limits: ValidatedLimits,
): Result<AdmittedFactsRequest, ScalarProtocolError> {
	return catchAsInvalid('facts request', () => {
		// Total parsing: reject any non-canonical JSON tree (exotic outer shapes,
		// cycles, proxies) before schema and semantic checks, and catch any residual
		// reflection or structuredClone failure, so nothing throws downstream.
		// One object plus its maximum two leaf members.
		if (!isCanonicalJson(value, 3) || !Value.Check(FactsRequestSchema, value)) {
			return ScalarProtocolError.Invalid({ boundary: 'facts request' });
		}
		// A fresh replica may omit the lifetime only when starting from zero.
		if (value.afterSequence > 0 && value.authorityLifetime === undefined) {
			return ScalarProtocolError.Invalid({ boundary: 'facts request' });
		}
		if (
			value.authorityLifetime !== undefined &&
			!isBoundedLifetime(value.authorityLifetime, limits)
		) {
			return ScalarProtocolError.Invalid({ boundary: 'facts request' });
		}
		return Ok(seal(value) as AdmittedFactsRequest);
	});
}

/**
 * Generic structural admission for a facts response.
 *
 * This checks the response in isolation. Installing a returned page and
 * advancing durable fact-feed progress needs request context, so that operation
 * must use `admitFactsPage` with the sealed facts request.
 */
export function parseFactsResponse(
	value: unknown,
	limits: ValidatedLimits,
): Result<FactsResponse, ScalarProtocolError> {
	return catchAsInvalid('facts response', () => {
		if (
			!isCanonicalJson(
				value,
				maxNodesForCanonicalBytes(limits.maxFactsResponseBytes),
			) ||
			!Value.Check(FactsResponseSchema, value)
		) {
			return ScalarProtocolError.Invalid({ boundary: 'facts response' });
		}
		if (!isBoundedLifetime(value.authorityLifetime, limits)) {
			return ScalarProtocolError.Invalid({ boundary: 'facts response' });
		}
		if (!value.facts.every((fact) => isAdmissibleFact(fact, limits))) {
			return ScalarProtocolError.Invalid({ boundary: 'facts response' });
		}
		// The feed is ordered by strictly increasing sequence, so every fact is for
		// a distinct address as well.
		if (
			value.facts.some((fact, index, facts) => {
				const prior = facts[index - 1];
				return prior !== undefined && fact.sequence <= prior.sequence;
			})
		) {
			return ScalarProtocolError.Invalid({ boundary: 'facts response' });
		}
		const addresses = new Set<string>();
		for (const fact of value.facts) {
			const key = addressKey(fact.address);
			if (addresses.has(key)) {
				return ScalarProtocolError.Invalid({ boundary: 'facts response' });
			}
			addresses.add(key);
		}
		// An empty response can never claim more facts remain.
		if (value.facts.length === 0 && value.hasMore) {
			return ScalarProtocolError.Invalid({ boundary: 'facts response' });
		}
		if (utf8ByteLength(canonicalize(value)) > limits.maxFactsResponseBytes) {
			return ScalarProtocolError.Invalid({ boundary: 'facts response' });
		}
		return Ok(structuredClone(value));
	});
}

/**
 * Context-aware facts-page admission: validate a facts response against the
 * exact sealed request that produced it.
 *
 * `durableFacts` is the replica's current persisted lifetime and
 * `afterSequence`, read inside the transaction that would install this page.
 * It must still exactly match the request, preventing delayed overlapping pages
 * or a response from before a lifetime rebind from committing. A fresh request
 * without a lifetime binds to the response lifetime. A bound request accepts
 * only that lifetime. Every returned fact must be strictly newer than the
 * requested exclusive cursor, so deriving the next cursor from the final fact
 * (or retaining the requested cursor for an empty page) cannot move fact-feed
 * progress backward.
 */
export function admitFactsPage(
	value: unknown,
	request: AdmittedFactsRequest,
	durableFacts: FactsRequest,
	limits: ValidatedLimits,
): Result<FactsResponse, ScalarProtocolError> {
	return catchAsInvalid('facts page', () => {
		const { data: response, error } = parseFactsResponse(value, limits);
		if (error !== null)
			return ScalarProtocolError.Invalid({ boundary: 'facts page' });

		if (
			durableFacts.authorityLifetime !== request.authorityLifetime ||
			durableFacts.afterSequence !== request.afterSequence
		) {
			return ScalarProtocolError.Invalid({
				boundary: 'facts page stale request',
			});
		}

		if (
			request.authorityLifetime !== undefined &&
			response.authorityLifetime !== request.authorityLifetime
		) {
			return ScalarProtocolError.Invalid({ boundary: 'facts page lifetime' });
		}

		if (response.facts.some((fact) => fact.sequence <= request.afterSequence)) {
			return ScalarProtocolError.Invalid({ boundary: 'facts page sequence' });
		}

		return Ok(response);
	});
}

// ---------------------------------------------------------------------------
// Submission operation
// ---------------------------------------------------------------------------

export const SubmissionRequestSchema = Type.Object(
	{
		authorityLifetime: LifetimeSchema,
		replicaId: ReplicaIdSchema,
		submissionNumber: SubmissionNumberSchema,
		intents: Type.Array(IntentSchema),
	},
	CLOSED,
);
export type SubmissionRequest = Static<typeof SubmissionRequestSchema>;

declare const admittedSubmission: unique symbol;
/**
 * A submission proven admissible: non-empty, bounded, every intent admissible,
 * at most one intent per address, and a well-formed bounded lifetime. Only
 * `parseSubmissionRequest` mints it, so `submit` cannot run on unadmitted input
 * and the touched-address list is guaranteed distinct.
 */
export type AdmittedSubmissionRequest = SubmissionRequest & {
	readonly [admittedSubmission]: true;
};

export const ParkedIntentSchema = Type.Object(
	{
		address: RowAddressSchema,
		code: Type.Literal('fact-too-large'),
		measuredBytes: NonNegativeIntegerSchema,
		limitBytes: NonNegativeIntegerSchema,
	},
	CLOSED,
);
export type ParkedIntent = Static<typeof ParkedIntentSchema>;

export const SubmissionResponseSchema = Type.Object(
	{
		authorityLifetime: LifetimeSchema,
		facts: Type.Array(FactSchema),
		parked: Type.Array(ParkedIntentSchema),
	},
	CLOSED,
);
export type SubmissionResponse = Static<typeof SubmissionResponseSchema>;

/** Whether an intent array holds at most one intent per distinct address. */
function addressesAreDistinct(
	intents: readonly { address: Address }[],
): boolean {
	const seen = new Set<string>();
	for (const intent of intents) {
		const key = addressKey(intent.address);
		if (seen.has(key)) return false;
		seen.add(key);
	}
	return true;
}

export function parseSubmissionRequest(
	value: unknown,
	limits: ValidatedLimits,
): Result<AdmittedSubmissionRequest, ScalarProtocolError> {
	return catchAsInvalid('submission request', () => {
		if (
			!isCanonicalJson(
				value,
				maxNodesForCanonicalBytes(limits.maxSubmissionBytes),
			) ||
			!Value.Check(SubmissionRequestSchema, value)
		) {
			return ScalarProtocolError.Invalid({ boundary: 'submission request' });
		}
		if (!isBoundedLifetime(value.authorityLifetime, limits)) {
			return ScalarProtocolError.Invalid({ boundary: 'submission request' });
		}
		// A submission with no intents does nothing and is not a valid numbered step.
		if (value.intents.length < 1) {
			return ScalarProtocolError.Invalid({ boundary: 'submission request' });
		}
		if (value.intents.length > limits.maxSubmissionAddresses) {
			return ScalarProtocolError.Invalid({ boundary: 'submission request' });
		}
		if (!value.intents.every((intent) => isAdmissibleIntent(intent, limits))) {
			return ScalarProtocolError.Invalid({ boundary: 'submission request' });
		}
		// The replica compacts to at most one intent per address before sealing.
		if (!addressesAreDistinct(value.intents)) {
			return ScalarProtocolError.Invalid({ boundary: 'submission request' });
		}
		if (utf8ByteLength(canonicalize(value)) > limits.maxSubmissionBytes) {
			return ScalarProtocolError.Invalid({ boundary: 'submission request' });
		}
		return Ok(seal(value) as AdmittedSubmissionRequest);
	});
}

/**
 * Generic structural admission for a submission response.
 *
 * This checks the response in isolation. Retiring durable local work needs more
 * than structure, so the operation that settles a submission must use
 * `admitSettlement` with the sealed submission as context.
 */
export function parseSubmissionResponse(
	value: unknown,
	limits: ValidatedLimits,
): Result<SubmissionResponse, ScalarProtocolError> {
	return catchAsInvalid('submission response', () => {
		if (
			!isCanonicalJson(
				value,
				maxNodesForCanonicalBytes(limits.maxSubmissionResponseBytes),
			) ||
			!Value.Check(SubmissionResponseSchema, value)
		) {
			return ScalarProtocolError.Invalid({ boundary: 'submission response' });
		}
		if (!isBoundedLifetime(value.authorityLifetime, limits)) {
			return ScalarProtocolError.Invalid({ boundary: 'submission response' });
		}
		if (!value.facts.every((fact) => isAdmissibleFact(fact, limits))) {
			return ScalarProtocolError.Invalid({ boundary: 'submission response' });
		}
		if (
			utf8ByteLength(canonicalize(value)) > limits.maxSubmissionResponseBytes
		) {
			return ScalarProtocolError.Invalid({ boundary: 'submission response' });
		}
		return Ok(structuredClone(value));
	});
}

/**
 * Context-aware settlement admission: validate a submission response against the
 * exact sealed submission it settles.
 *
 * `durableSettlement` is the replica's current persisted authority lifetime and
 * sealed submission, read inside the transaction that would install the
 * response. Both must still match the request. This prevents a delayed response
 * from a superseded lifetime, or for work that is no longer sealed, from
 * mutating a rebound replica.
 *
 * A response that retires durable work must return exactly one current fact per
 * intent, in sealed order, with globally distinct sequences; its parked entries
 * must be an ordered, distinct subset of the touched row addresses, each with a
 * `limitBytes` equal to the configured encoded-fact ceiling and a `measuredBytes`
 * strictly greater than that ceiling.
 */
export function admitSettlement(
	value: unknown,
	request: AdmittedSubmissionRequest,
	durableSettlement: {
		authorityLifetime: string;
		sealedSubmission: SubmissionRequest | undefined;
	},
	limits: ValidatedLimits,
): Result<SubmissionResponse, ScalarProtocolError> {
	return catchAsInvalid('settlement', () => {
		const { data: response, error } = parseSubmissionResponse(value, limits);
		if (error !== null)
			return ScalarProtocolError.Invalid({ boundary: 'settlement' });

		if (
			durableSettlement.authorityLifetime !== request.authorityLifetime ||
			response.authorityLifetime !== request.authorityLifetime
		) {
			return ScalarProtocolError.Invalid({ boundary: 'settlement lifetime' });
		}
		if (
			durableSettlement.sealedSubmission === undefined ||
			canonicalize(durableSettlement.sealedSubmission) !== canonicalize(request)
		) {
			return ScalarProtocolError.Invalid({
				boundary: 'settlement stale request',
			});
		}

		const sealed = request.intents;
		// Exactly one fact per intent, in sealed order.
		if (response.facts.length !== sealed.length) {
			return ScalarProtocolError.Invalid({ boundary: 'settlement fact count' });
		}
		for (let index = 0; index < sealed.length; index += 1) {
			const fact = response.facts[index];
			const intent = sealed[index];
			if (
				fact === undefined ||
				intent === undefined ||
				!addressesEqual(fact.address, intent.address)
			) {
				return ScalarProtocolError.Invalid({
					boundary: 'settlement fact order',
				});
			}
		}
		// Facts use globally distinct sequences.
		const sequences = new Set<number>();
		for (const fact of response.facts) {
			if (sequences.has(fact.sequence)) {
				return ScalarProtocolError.Invalid({
					boundary: 'settlement fact sequence',
				});
			}
			sequences.add(fact.sequence);
		}
		// Parked entries are an ordered, distinct subset of the touched row
		// addresses.
		let sealedIndex = 0;
		const parkedSeen = new Set<string>();
		for (const parked of response.parked) {
			if (!isAdmissibleAddress(parked.address, limits)) {
				return ScalarProtocolError.Invalid({
					boundary: 'settlement parked address',
				});
			}
			const key = addressKey(parked.address);
			if (parkedSeen.has(key)) {
				return ScalarProtocolError.Invalid({
					boundary: 'settlement parked duplicate',
				});
			}
			parkedSeen.add(key);
			let found = false;
			while (sealedIndex < sealed.length) {
				const intent = sealed[sealedIndex];
				sealedIndex += 1;
				// Parking is legal only for a row-present patch folded over a live
				// base, never for a row-absent delete, so the matched intent must be
				// present.
				if (
					intent !== undefined &&
					intent.presence === 'present' &&
					'set' in intent &&
					addressKey(intent.address) === key
				) {
					found = true;
					break;
				}
			}
			if (!found) {
				return ScalarProtocolError.Invalid({
					boundary: 'settlement parked order',
				});
			}
			if (parked.limitBytes !== limits.maxEncodedFactBytes) {
				return ScalarProtocolError.Invalid({
					boundary: 'settlement parked limit',
				});
			}
			if (parked.measuredBytes <= parked.limitBytes) {
				return ScalarProtocolError.Invalid({
					boundary: 'settlement parked measurement',
				});
			}
		}
		return Ok(response);
	});
}
