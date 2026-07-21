/**
 * Reference authority: a pure, in-memory model of the scalar V1 authority.
 *
 * This is the semantic contract that Wave 2c will realize over SQLite. It owns
 * no storage and no runtime, so every law can be proven as a state transition.
 * `readFacts` and `submit` are the two authority operations behind the two wire
 * operations; each is a pure function of `(state, request, limits)`.
 *
 * Inputs are opaque admitted values: the request types are minted only by the
 * protocol parsers, and the limits only by `validateLimits`, so an in-process
 * caller cannot bypass admission. A duplicate-address submission or a
 * lifetime-less non-zero facts read is impossible to construct.
 *
 * Ownership is strict. Everything the authority retains is deeply detached from
 * the caller's request, and every public response is a deep clone, so no
 * response, ledger entry, or successor state ever aliases another state's facts.
 *
 * Atomicity is structural. `submit` builds a complete successor state and
 * returns it only on success; any refusal returns an error and the original
 * state, so the fold, sequence assignment, retry bookkeeping, parked results,
 * and result-fact read commit together or not at all.
 *
 * The authority stores one current fact per address, one global sequence
 * counter, and one small ledger per replica for exact-retry and fork detection.
 * It keeps no change log, receipt history, or public digest.
 */
import { Ok, type Result } from 'wellcrafted/result';

import { type Address, addressKey } from './addresses.js';
import {
	canonicalize,
	isWellFormedString,
	sha256Hex,
	utf8ByteLength,
} from './canonical.js';
import { AuthorityError, ScalarProtocolError } from './errors.js';
import { encodedFactBytes, type Fact } from './facts.js';
import { foldIntent } from './fold.js';
import type { ValidatedLimits } from './limits.js';
import type {
	AdmittedFactsRequest,
	AdmittedSubmissionRequest,
	FactsResponse,
	ParkedIntent,
	SubmissionResponse,
} from './operations.js';

/** Deep copy that detaches a value from every state and caller reference. */
function detach<T>(value: T): T {
	return structuredClone(value);
}

/** Per-replica exact-retry and fork-detection ledger. */
export type ReplicaLedger = {
	/** Last completed submission number; 0 before the replica's first submission. */
	readonly lastSubmissionNumber: number;
	/** SHA-256 of the canonical last request; private fork-detection witness. */
	readonly lastRequestHash: string;
	/** Addresses touched by the last submission, in sealed intent order. */
	readonly touchedAddresses: readonly Address[];
	/** Bounded parked results of the last submission, remembered for exact retry. */
	readonly parked: readonly ParkedIntent[];
};

export type AuthorityState = {
	/** Opaque, equality-only authority lifetime identity. */
	readonly lifetime: string;
	/** Next authority sequence to assign; starts at 1. */
	readonly nextSequence: number;
	/** Current fact per address, keyed by private structured-address identity. */
	readonly facts: ReadonlyMap<string, Fact>;
	/** Per-replica ledgers, keyed by replica id. */
	readonly replicas: ReadonlyMap<string, ReplicaLedger>;
};

/**
 * Construct a fresh authority under an admitted opaque lifetime.
 *
 * Total over unknown input. The lifetime is the one non-branded value the
 * authority admits, so it is typed `unknown` and every non-string (number,
 * `null`, `undefined`, symbol, object, or proxy) returns a typed `Invalid`
 * rather than throwing: the `typeof` guard short-circuits before any string
 * method runs. Only a non-empty, well-formed string within the wire's lifetime
 * bound is admitted, so a created authority can never emit a facts response its
 * own parser would reject or throw while packing facts.
 */
export function createAuthority(
	lifetime: unknown,
	limits: ValidatedLimits,
): Result<AuthorityState, ScalarProtocolError> {
	if (
		typeof lifetime !== 'string' ||
		lifetime.length === 0 ||
		!isWellFormedString(lifetime) ||
		utf8ByteLength(lifetime) > limits.maxLifetimeBytes
	) {
		return ScalarProtocolError.Invalid({ boundary: 'authority lifetime' });
	}
	return Ok({
		lifetime,
		nextSequence: 1,
		facts: new Map(),
		replicas: new Map(),
	});
}

/** The last assigned authority sequence, or 0 when nothing has been written. */
function activeSequence(state: AuthorityState): number {
	return state.nextSequence - 1;
}

/**
 * Read current facts whose sequence is greater than `afterSequence`.
 *
 * Returns the largest sequence-ordered prefix that fits the facts-response byte
 * budget, with `hasMore` computed from the same snapshot. Because validated
 * limits guarantee one maximum fact always fits, the prefix is non-empty
 * whenever any fact qualifies, so an empty response never claims more. A
 * superseded lifetime is a terminal mismatch; a sequence beyond the active
 * authority in the same lifetime is corruption.
 */
export function readFacts(
	state: AuthorityState,
	request: AdmittedFactsRequest,
	limits: ValidatedLimits,
): Result<FactsResponse, AuthorityError> {
	if (
		request.authorityLifetime !== undefined &&
		request.authorityLifetime !== state.lifetime
	) {
		return AuthorityError.LifetimeMismatch({
			requested: request.authorityLifetime,
			active: state.lifetime,
		});
	}
	const active = activeSequence(state);
	if (request.afterSequence > active) {
		return AuthorityError.SequenceAhead({
			requestedAfterSequence: request.afterSequence,
			activeSequence: active,
		});
	}

	// One consistent snapshot of qualifying facts, ordered by sequence.
	const qualifying = [...state.facts.values()]
		.filter((fact) => fact.sequence > request.afterSequence)
		.sort((left, right) => left.sequence - right.sequence);

	// The largest sequence-ordered prefix that fits the response budget. One
	// maximum fact is guaranteed to fit, so a non-empty snapshot yields a
	// non-empty prefix.
	let prefixCount = 0;
	for (let index = 0; index < qualifying.length; index += 1) {
		const candidate: FactsResponse = {
			authorityLifetime: state.lifetime,
			facts: qualifying.slice(0, index + 1),
			hasMore: index + 1 < qualifying.length,
		};
		if (
			utf8ByteLength(canonicalize(candidate)) > limits.maxFactsResponseBytes
		) {
			break;
		}
		prefixCount = index + 1;
	}

	return Ok({
		authorityLifetime: state.lifetime,
		facts: qualifying.slice(0, prefixCount).map(detach),
		hasMore: prefixCount < qualifying.length,
	});
}

function currentFactsFor(
	facts: ReadonlyMap<string, Fact>,
	addresses: readonly Address[],
): Fact[] {
	const result: Fact[] = [];
	for (const address of addresses) {
		const fact = facts.get(addressKey(address));
		if (fact !== undefined) result.push(detach(fact));
	}
	return result;
}

/**
 * Adjudicate one numbered submission.
 *
 * Exact retry of the last completed number returns current facts for the sealed
 * touched addresses plus the remembered parked results. A reused number with
 * different content is a fork; a number other than the expected next is a gap.
 * A new submission folds each intent in order, assigns a sequence only when the
 * current fact changes, refuses before assigning a sequence beyond the JSON-safe
 * range, parks a row patch whose folded fact exceeds the encoded ceiling, and
 * returns the current fact for every distinct touched address in sealed order.
 */
export function submit(
	state: AuthorityState,
	request: AdmittedSubmissionRequest,
	limits: ValidatedLimits,
): Result<
	{ state: AuthorityState; response: SubmissionResponse },
	AuthorityError
> {
	if (request.authorityLifetime !== state.lifetime) {
		return AuthorityError.LifetimeMismatch({
			requested: request.authorityLifetime,
			active: state.lifetime,
		});
	}

	const ledger = state.replicas.get(request.replicaId);
	const lastNumber = ledger?.lastSubmissionNumber ?? 0;
	const requestHash = sha256Hex(canonicalize(request));

	// Exact retry of the last completed submission.
	if (ledger !== undefined && request.submissionNumber === lastNumber) {
		if (requestHash !== ledger.lastRequestHash) {
			return AuthorityError.SubmissionFork({
				submissionNumber: request.submissionNumber,
			});
		}
		return Ok({
			state,
			response: {
				authorityLifetime: state.lifetime,
				facts: currentFactsFor(state.facts, ledger.touchedAddresses),
				parked: detach([...ledger.parked]),
			},
		});
	}

	// Otherwise the number must be exactly the next in this replica's stream.
	const expectedNumber = lastNumber + 1;
	if (request.submissionNumber !== expectedNumber) {
		return AuthorityError.SubmissionGap({
			submissionNumber: request.submissionNumber,
			expectedNumber,
		});
	}

	// Fold each intent into a successor fact map. Carried facts are deep-cloned so
	// the successor shares no nested object with the predecessor.
	const facts = new Map<string, Fact>();
	for (const [key, fact] of state.facts) facts.set(key, detach(fact));
	let nextSequence = state.nextSequence;
	const parked: ParkedIntent[] = [];
	for (const intent of request.intents) {
		const key = addressKey(intent.address);
		const outcome = foldIntent(facts.get(key), intent, nextSequence);
		if (outcome.kind === 'unchanged') continue;
		const measuredBytes = encodedFactBytes(outcome.fact);
		if (
			outcome.fact.presence === 'present' &&
			'fields' in outcome.fact &&
			measuredBytes > limits.maxEncodedFactBytes
		) {
			// A row patch folded over a different live base overflowed. Park it and
			// leave the current fact untouched, so the address keeps its live row.
			parked.push({
				address: detach(outcome.fact.address),
				code: 'fact-too-large',
				measuredBytes,
				limitBytes: limits.maxEncodedFactBytes,
			});
			continue;
		}
		// Refuse before storing a fact whose sequence would leave the safe range.
		// `nextSequence` may transiently reach MAX_SAFE_INTEGER + 1 here as an
		// internal exhaustion sentinel, but no fact carrying it is ever stored.
		if (!Number.isSafeInteger(nextSequence)) {
			return AuthorityError.SequenceExhausted({ nextSequence });
		}
		facts.set(key, detach(outcome.fact));
		nextSequence += 1;
	}

	const touchedAddresses = request.intents.map((intent) =>
		detach(intent.address),
	);
	const nextLedger: ReplicaLedger = {
		lastSubmissionNumber: request.submissionNumber,
		lastRequestHash: requestHash,
		touchedAddresses,
		parked: detach(parked),
	};
	// Carried ledgers are deep-cloned so another replica's later submission cannot
	// retroactively mutate this successor's exact-retry bookkeeping (or vice versa).
	const replicas = new Map<string, ReplicaLedger>();
	for (const [id, entry] of state.replicas) replicas.set(id, detach(entry));
	replicas.set(request.replicaId, nextLedger);

	return Ok({
		state: { lifetime: state.lifetime, nextSequence, facts, replicas },
		response: {
			authorityLifetime: state.lifetime,
			facts: currentFactsFor(facts, touchedAddresses),
			parked: detach(parked),
		},
	});
}
