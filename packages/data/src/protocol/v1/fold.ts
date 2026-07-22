/**
 * The one operation algebra: authority fold and operation composition
 * (ADR-0163, ADR-0164).
 *
 * One composition law governs pending compaction, parked compaction at
 * settlement, and the authority fold alike, and absorption is evaluated
 * first: if the existing state or the existing composed operation is
 * `tombstone`, every later operation composes to `tombstone`, before any
 * payload or operation-specific logic runs. `unset` followed by `replace` is
 * legal resurrection, because `unset` is a different stored state than
 * `tombstone`.
 *
 * `foldIntent` is the whole convergence law at a single record address: one
 * current fact plus one operation yields the next fact, expressed as a pure
 * function so it can be proven without storage or runtime. `current` is the
 * address's current fact, or `undefined` when the address has no fact.
 * `nextSequence` is the sequence the authority would assign if the fold
 * changes the current fact.
 *
 * The fold reports `unchanged` when the operation leaves the current fact
 * identical, so the authority assigns a new sequence only when the current
 * fact actually changes. It reports `refused` with `patch-base-not-object`
 * when a patch would fold over a live non-object payload; the authority parks
 * that operation and leaves the current fact untouched. It never applies a
 * byte ceiling; the authority measures the candidate fact and decides whether
 * to park it.
 *
 * `composeOperations` compacts two operations at one address into one that
 * reproduces sequential application against every base state. Composing a
 * patch onto a composed `replace` whose value is not an object is refused
 * with the same `patch-base-not-object` code the fold uses: sequential
 * application would park that patch at the authority, and no single operation
 * expresses "install, then park".
 *
 * Precondition: `current`, when defined, is the fact at `intent.address`. The
 * authority guarantees this by looking the fact up by structured address.
 */
import { canonicalize } from './canonical.js';
import type { Fact } from './facts.js';
import type { JsonObject, JsonValue } from './json.js';
import type { Intent, Operation } from './operations.js';

export type FoldOutcome =
	| { kind: 'unchanged' }
	| { kind: 'changed'; fact: Fact }
	| { kind: 'refused'; code: 'patch-base-not-object' };

const UNCHANGED: FoldOutcome = { kind: 'unchanged' };
const REFUSED: FoldOutcome = {
	kind: 'refused',
	code: 'patch-base-not-object',
};

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
	return canonicalize(left) === canonicalize(right);
}

/** Whether a live payload can serve as a patch base. */
function isObjectPayload(payload: JsonValue): payload is JsonObject {
	return (
		typeof payload === 'object' && payload !== null && !Array.isArray(payload)
	);
}

function patchFields(
	base: JsonObject,
	set: JsonObject,
	unset: readonly string[],
): JsonObject {
	const fields: JsonObject = structuredClone(base);
	for (const [key, value] of Object.entries(set)) {
		fields[key] = structuredClone(value);
	}
	for (const key of unset) delete fields[key];
	return fields;
}

export function foldIntent(
	current: Fact | undefined,
	intent: Intent,
	nextSequence: number,
): FoldOutcome {
	// Absorption first: a stored tombstone settles every later operation as
	// superseded, before any payload or operation-specific logic.
	if (current?.state === 'tombstone') return UNCHANGED;

	const address = intent.address;
	switch (intent.op) {
		case 'tombstone': {
			return {
				kind: 'changed',
				fact: { address, sequence: nextSequence, state: 'tombstone' },
			};
		}
		case 'unset': {
			if (current?.state === 'unset') return UNCHANGED;
			return {
				kind: 'changed',
				fact: { address, sequence: nextSequence, state: 'unset' },
			};
		}
		case 'replace': {
			if (
				current?.state === 'live' &&
				jsonEqual(intent.value, current.payload)
			) {
				return UNCHANGED; // idempotent replacement
			}
			return {
				kind: 'changed',
				fact: {
					address,
					sequence: nextSequence,
					state: 'live',
					payload: structuredClone(intent.value),
				},
			};
		}
		case 'patch': {
			// Patch folds over the live payload, or over an empty object when the
			// address has no live fact (never learned, or reversibly unset).
			let base: JsonObject;
			if (current?.state === 'live') {
				if (!isObjectPayload(current.payload)) return REFUSED;
				base = current.payload;
			} else {
				base = {};
			}
			const payload = patchFields(base, intent.set, intent.unset);
			if (current?.state === 'live' && jsonEqual(payload, current.payload)) {
				return UNCHANGED; // idempotent patch
			}
			return {
				kind: 'changed',
				fact: { address, sequence: nextSequence, state: 'live', payload },
			};
		}
	}
}

export type ComposeOutcome =
	| { kind: 'composed'; operation: Operation }
	| { kind: 'refused'; code: 'patch-base-not-object' };

const TOMBSTONE: ComposeOutcome = {
	kind: 'composed',
	operation: { op: 'tombstone' },
};
const COMPOSE_REFUSED: ComposeOutcome = {
	kind: 'refused',
	code: 'patch-base-not-object',
};

function composed(operation: Operation): ComposeOutcome {
	return { kind: 'composed', operation };
}

/**
 * Compose `older` then `newer` into one operation equivalent to applying both
 * in sequence, against every base state.
 */
export function composeOperations(
	older: Operation,
	newer: Operation,
): ComposeOutcome {
	// Absorption first: a tombstone on either side composes to tombstone.
	if (older.op === 'tombstone' || newer.op === 'tombstone') return TOMBSTONE;

	// A non-patch newer operation determines the outcome alone.
	if (newer.op === 'unset') return composed({ op: 'unset' });
	if (newer.op === 'replace') {
		return composed({ op: 'replace', value: structuredClone(newer.value) });
	}

	// newer is a patch; it folds over whatever `older` establishes.
	switch (older.op) {
		case 'unset': {
			// After a reversible absence the patch folds over an empty object. The
			// compacted form must be a replace: a patch would fold over an arbitrary
			// live base at the authority instead of the empty base `unset` created.
			return composed({
				op: 'replace',
				value: patchFields({}, newer.set, newer.unset),
			});
		}
		case 'replace': {
			if (!isObjectPayload(older.value)) return COMPOSE_REFUSED;
			return composed({
				op: 'replace',
				value: patchFields(older.value, newer.set, newer.unset),
			});
		}
		case 'patch': {
			// Merge two field patches. The newer patch's set and unset each override
			// the older patch key-by-key; the result keeps set and unset disjoint.
			const newerSet = new Set(Object.keys(newer.set));
			const newerUnset = new Set(newer.unset);
			const set: JsonObject = {};
			for (const [key, value] of Object.entries(older.set)) {
				if (!newerSet.has(key) && !newerUnset.has(key)) {
					set[key] = structuredClone(value);
				}
			}
			for (const [key, value] of Object.entries(newer.set)) {
				set[key] = structuredClone(value);
			}
			const unset = [
				...older.unset.filter(
					(key) => !newerSet.has(key) && !newerUnset.has(key),
				),
				...newer.unset,
			];
			return composed({ op: 'patch', set, unset });
		}
	}
}
