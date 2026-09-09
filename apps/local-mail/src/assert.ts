import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { IntentStore, LabelAssertion } from './intent-store.ts';

/**
 * Record the label IDs captured by the UI directly into durable intentions.
 * This path needs no cache or Gmail connection. Every choice gets a fresh
 * revision, even when cached labels already agree: undo must supersede an
 * in-flight delivery, whose eventual retirement can only match its old revision.
 */

/** The cap on how many messages one act covers. Deliberately not Gmail's
 * per-request limit: nothing here is a request. It exists so a mistyped bulk act
 * cannot record an unbounded drain, and it is refused with the count rather than
 * silently truncated. */
const MAX_MESSAGES_PER_ACT = 500;

/**
 * Gmail's own per-request ceiling: `messages.modify` accepts at most 100 label
 * ids in `addLabelIds` and 100 in `removeLabelIds` (Gmail API reference,
 * verified 2026-08-01). Enforced here, in the core rather than only in the MCP
 * tool schema, so no surface can record an act whose shape Gmail would refuse.
 *
 * Scope, precisely: this bounds ONE act, not the total pending for a message.
 * Two acts of 60 labels each leave 120 pending for the same message, and the
 * drain groups them into one request Gmail will refuse. That case is handled
 * where it happens rather than pre-empted here: a refused group is retried one
 * assertion at a time, so every one of them still lands (see `reconcile.ts`).
 * The cost is one wasted request in a case that needs an account with a hundred
 * custom labels to reach at all.
 */
const MAX_LABELS_PER_DIRECTION = 100;

export const AssertLabelsError = defineErrors({
	NoMessageIds: () => ({
		message: 'At least one Gmail message id is required.',
	}),
	TooManyMessageIds: ({ count }: { count: number }) => ({
		message: `One act covers at most ${MAX_MESSAGES_PER_ACT} messages, got ${count}.`,
		count,
	}),
	EmptyLabelMutation: () => ({
		message: 'At least one label must be added or removed.',
	}),
	TooManyLabels: ({
		direction,
		count,
	}: {
		direction: 'added' | 'removed';
		count: number;
	}) => ({
		message: `Gmail accepts at most ${MAX_LABELS_PER_DIRECTION} labels ${direction} in one change, got ${count}.`,
		direction,
		count,
	}),
	/** One act cannot both want and not want the same label. Resolving it by
	 * list order would make the outcome depend on how the caller happened to
	 * spell it, so it is refused instead. */
	ContradictoryLabel: ({ label }: { label: string }) => ({
		message: `Label "${label}" is asked to be both added and removed by the same act.`,
		label,
	}),
});
export type AssertLabelsError = InferErrors<typeof AssertLabelsError>;

export type AssertLabelsInput = {
	/** Concrete message ids, snapshotted by the surface at act time. */
	ids: string[];
	/** Gmail label ids to put on those messages. */
	addLabels: string[];
	/** Gmail label ids to take off those messages. */
	removeLabels: string[];
};

export type AssertLabelsOutcome = {
	/** `(message, label)` pairs this act recorded, each at a fresh revision.
	 * Always `ids.length * (addLabels.length + removeLabels.length)`: an act
	 * that agrees with the mirror is still recorded, so this is a count of what
	 * was asked for, not of what looked worth keeping. */
	asserted: number;
};

export type AssertDeps = {
	intents: IntentStore;
	/** The act's clock. Injected like every other clock here, and stamped onto
	 * each assertion so a status surface can report how long the oldest
	 * undelivered change has waited. */
	now: () => number;
};

/**
 * Record one triage act. Returns how much it recorded; there is no per-id
 * outcome because no id can fail: the act is a local write, and delivery is
 * somebody else's pass.
 */
export async function assertMessageLabels({
	deps,
	input,
}: {
	deps: AssertDeps;
	input: AssertLabelsInput;
}): Promise<Result<AssertLabelsOutcome, AssertLabelsError>> {
	if (input.ids.length === 0) return AssertLabelsError.NoMessageIds();
	if (input.ids.length > MAX_MESSAGES_PER_ACT) {
		return AssertLabelsError.TooManyMessageIds({ count: input.ids.length });
	}
	if (input.addLabels.length === 0 && input.removeLabels.length === 0) {
		return AssertLabelsError.EmptyLabelMutation();
	}
	if (input.addLabels.length > MAX_LABELS_PER_DIRECTION) {
		return AssertLabelsError.TooManyLabels({
			direction: 'added',
			count: input.addLabels.length,
		});
	}
	if (input.removeLabels.length > MAX_LABELS_PER_DIRECTION) {
		return AssertLabelsError.TooManyLabels({
			direction: 'removed',
			count: input.removeLabels.length,
		});
	}

	const wanted = input.addLabels;
	const unwanted = input.removeLabels;
	const contradiction = wanted.find((id) => unwanted.includes(id));
	if (contradiction) {
		return AssertLabelsError.ContradictoryLabel({ label: contradiction });
	}

	const opinions: [labelId: string, want: boolean][] = [
		...wanted.map((id): [string, boolean] => [id, true]),
		...unwanted.map((id): [string, boolean] => [id, false]),
	];

	const assertions: LabelAssertion[] = [];
	for (const messageId of input.ids) {
		for (const [labelId, want] of opinions) {
			assertions.push({ messageId, labelId, want });
		}
	}

	return Ok({
		asserted: await deps.intents.assert(
			assertions,
			new Date(deps.now()).toISOString(),
		),
	});
}
