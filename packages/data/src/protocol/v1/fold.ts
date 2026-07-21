/**
 * Pure authority fold: one current fact plus one intent yields the next fact.
 *
 * This is the whole convergence law at a single scalar address, expressed as a
 * pure function so it can be reasoned about and proven without any storage or
 * runtime. `current` is the address's current fact, or `undefined` when the
 * address has no fact (a replica has learned nothing there). `nextSequence` is
 * the sequence the authority would assign if this fold changes the current
 * fact.
 *
 * The fold reports `unchanged` when the intent leaves the current fact
 * identical, so the authority assigns a new sequence only when the current fact
 * actually changes. It never applies a byte ceiling; the authority measures the
 * candidate fact and decides whether to park it.
 *
 * Invariants encoded here:
 * - Row-present is upsert-patch: it folds over the live row, or over an empty
 *   object when the address has no fact.
 * - A terminal row tombstone dominates: a later row-present intent settles as
 *   superseded without resurrecting the row.
 * - A row-absent intent installs or preserves the terminal tombstone.
 * - Value-present replaces; value-absent installs or preserves the reversible
 *   unset.
 * - `set` is applied before `unset`.
 *
 * Precondition: `current`, when defined, is the fact at `intent.address` (same
 * address kind). The authority guarantees this by looking the fact up by
 * structured address.
 */
import { canonicalize } from './canonical.js';
import type { Fact } from './facts.js';
import type { Intent } from './intents.js';
import type { JsonObject, JsonValue } from './json.js';

export type FoldOutcome =
	| { kind: 'unchanged' }
	| { kind: 'changed'; fact: Fact };

const UNCHANGED: FoldOutcome = { kind: 'unchanged' };

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
	return canonicalize(left) === canonicalize(right);
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
	if (intent.presence === 'present') {
		if ('set' in intent) {
			// row-present upsert-patch
			if (current?.presence === 'absent') return UNCHANGED; // tombstone dominates
			const base =
				current?.presence === 'present' && 'fields' in current
					? current.fields
					: {};
			const fields = patchFields(base, intent.set, intent.unset);
			if (
				current?.presence === 'present' &&
				'fields' in current &&
				jsonEqual(fields, current.fields)
			) {
				return UNCHANGED; // idempotent row patch
			}
			return {
				kind: 'changed',
				fact: {
					address: intent.address,
					sequence: nextSequence,
					presence: 'present',
					fields,
				},
			};
		}
		// value-present replace
		if (
			current?.presence === 'present' &&
			'content' in current &&
			jsonEqual(intent.content, current.content)
		) {
			return UNCHANGED; // idempotent value set
		}
		return {
			kind: 'changed',
			fact: {
				address: intent.address,
				sequence: nextSequence,
				presence: 'present',
				content: structuredClone(intent.content),
			},
		};
	}

	// absent intent
	if (current?.presence === 'absent') return UNCHANGED; // preserve tombstone / unset
	const address = intent.address;
	return {
		kind: 'changed',
		fact:
			address.kind === 'row'
				? { address, sequence: nextSequence, presence: 'absent' }
				: { address, sequence: nextSequence, presence: 'absent' },
	};
}
